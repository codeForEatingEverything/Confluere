"use client";

/**
 * Hooks over lib/product for the simple screens. All read the active chain; each returns the usual query fields
 * (`isLoading`, `isError`) of the slowest input so the UI can show a skeleton or the network line, never an empty
 * state caused by a failed read.
 */
import { useMemo } from "react";
import { useConnection } from "wagmi";
import { Status } from "@confluere/sdk";
import type { Address } from "viem";
import { useActiveChain } from "./activeChain";
import { useAccountOrders, useBlockTime, useChainCtx, useNow, usePoolSupplies, usePools, useTokens, useVaults, type PoolRow } from "./data";
import { usePending, usePositions } from "./position";
import { useRefPrice } from "./refPrice";
import { useVaultsMe } from "./vaultMe";
import { pairsOf, pickBorrowOffer, pickLendOffer, summarizePortfolio, termsFor, type StrikeTier } from "./product";
import type { ActionCtx } from "./actions";
import type { Tx } from "./tx";
import { useViewAddress } from "./demo/hooks";

/** Chain time (block timestamp) and block for product math; 0 / 0n until the first block arrives. */
export function useChainClock() {
  const now = useNow();
  return { now: now.data?.ts ?? 0, block: now.data?.block ?? 0n, ready: !!now.data };
}

/** Context for lib/actions builders, or undefined until wallet, client and deployment are there. */
export function useActionCtx(tx: Pick<Tx, "ensureAllowance">): ActionCtx | undefined {
  const { client, deployment } = useChainCtx();
  const { address } = useConnection();
  return useMemo(
    () =>
      client && deployment && address
        ? { client, core: deployment.confluere, account: address, windowBlocks: deployment.windowBlocks, ensureAllowance: tx.ensureAllowance }
        : undefined,
    [client, deployment, address, tx.ensureAllowance],
  );
}

/** Collateral/quote pairs with pools on the active chain (the token selector's list), with token metadata. */
export function usePairs() {
  const pools = usePools();
  const { now, block } = useChainClock();
  const pairs = useMemo(() => pairsOf(pools.data ?? [], now, block), [pools.data, now, block]);
  const tokens = useTokens(pairs.flatMap((p) => [p.asset, p.quote]));
  return { pairs, tokens: tokens.data, isLoading: pools.isLoading || (pairs.length > 0 && tokens.isLoading), isError: pools.isError, discovering: pools.discovering };
}

/**
 * Open maturities of one pair with an offer per pool (receive / repay per unit, fixed APR, gap to the display-only
 * reference price). `kind` filters American (0) / European (1); omitted = both.
 */
export function useTerms(pair: { asset?: Address; quote?: Address; kind?: number; includeClosed?: boolean }) {
  const pools = usePools();
  const { now, block, ready } = useChainClock();
  const tokens = useTokens([pair.asset, pair.quote].filter((a): a is Address => !!a));
  const ref = useRefPrice(pair.asset, pair.quote);
  const qd = pair.quote ? tokens.data?.[pair.quote.toLowerCase()]?.decimals : undefined;
  const terms = useMemo(
    () =>
      pair.asset && pair.quote && ready
        ? termsFor(pools.data ?? [], { asset: pair.asset, quote: pair.quote, kind: pair.kind, now, block, ref: ref.data, quoteDecimals: qd, includeClosed: pair.includeClosed })
        : [],
    [pools.data, pair.asset, pair.quote, pair.kind, pair.includeClosed, now, block, ready, ref.data, qd],
  );
  return { terms, tokens: tokens.data, ref: ref.data ?? undefined, isLoading: pools.isLoading || !ready, isError: pools.isError, discovering: pools.discovering };
}

/** Best pool to borrow in for a maturity (soonest open when omitted) and a level (low = lowest buy-back price). */
export function useBorrowPick(pair: { asset?: Address; quote?: Address; kind?: number }, o: { expiry?: number; tier: StrikeTier }) {
  const t = useTerms(pair);
  const offer = useMemo(() => pickBorrowOffer(t.terms, o), [t.terms, o.expiry, o.tier]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...t, offer };
}

/** Best pool to lend in: `apr` = highest fixed APR, `safe` = lowest buy-back price. */
export function useLendPick(pair: { asset?: Address; quote?: Address; kind?: number }, o: { expiry?: number; goal: "apr" | "safe" }) {
  const t = useTerms(pair);
  const offer = useMemo(() => pickLendOffer(t.terms, o), [t.terms, o.expiry, o.goal]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...t, offer };
}

/**
 * Everything the connected account has on the active chain: loans (buy-back rights), lending positions, balances
 * waiting to be withdrawn, vault shares and requests, open orders, and a count of things that need action.
 */
export function usePortfolio() {
  const { deployment } = useActiveChain();
  const address = useViewAddress();
  const pools = usePools();
  const rows = pools.data ?? [];
  const ids = useMemo(() => rows.map((p) => p.id), [rows]);
  const positions = usePositions(ids);
  const held = useMemo(() => rows.filter((p) => { const x = positions.data?.[p.id]; return !!x && (x.c > 0n || x.r > 0n); }), [rows, positions.data]);
  const supplies = usePoolSupplies(held.filter((p) => p.status === Status.Closed).map((p) => p.id));
  const tokens = useMemo(() => [...new Set(rows.flatMap((p) => [p.asset, p.quote]).map((a) => a.toLowerCase() as Address))], [rows]);
  const vaults = useVaults();
  const allTokens = useMemo(() => [...new Set([...tokens, ...(vaults.data ?? []).flatMap((v) => [v.quote, ...v.assets]).map((a) => a.toLowerCase() as Address)])], [tokens, vaults.data]);
  const pending = usePending(allTokens);
  const vaultsMe = useVaultsMe(vaults.data);
  const meta = useTokens(allTokens);
  const orders = useAccountOrders();
  const { now, block, ready } = useChainClock();
  const summary = useMemo(
    () =>
      summarizePortfolio({
        pools: held,
        positions: positions.data,
        supplies: supplies.data,
        pending: pending.data,
        vaults: (vaults.data ?? []).map((v) => ({ vault: v, me: vaultsMe.data?.[v.address.toLowerCase()] })),
        now,
        block,
      }),
    [held, positions.data, supplies.data, pending.data, vaults.data, vaultsMe.data, now, block],
  );
  const isLoading = !!address && !!deployment && (pools.isLoading || positions.isLoading || pending.isLoading || vaults.isLoading || !ready);
  const isError = pools.isError || positions.isError || pending.isError || vaults.isError || vaultsMe.isError;
  return { ...summary, orders: orders.data ?? [], tokens: meta.data, connected: !!address, isLoading, isError, pools: rows as PoolRow[] };
}

/** Seconds per block on the active chain (null when it cannot be measured), for "≈ time" next to block counts. */
export const useSecondsPerBlock = () => useBlockTime().data ?? null;
