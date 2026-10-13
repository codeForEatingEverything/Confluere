"use client";

/** Harberger seats (blueprint §9): one per market, read from SeatRegistry. */
import { useQuery } from "@tanstack/react-query";
import { zeroAddress, type Address, type Hex } from "viem";
import { confluereAbi, quoteDown, scaleOf, seatRegistryAbi, type Kind } from "@confluere/sdk";
import { readMany } from "./many";
import { REFRESH_MS, useChainCtx } from "./data";
import { useViewAddress } from "./demo/hooks";

export type SeatView = {
  holder: Address;
  price: bigint;
  deposit: bigint;
  bond: bigint;
  lastTax: number;
  priceLockedUntil: number;
  lastQuotedBatch: number;
  taxOwed: bigint;
  obligation: bigint; // per batch, in quote at K; 0 = no seats for this quote token
  mine: bigint; // claimable for the connected account
  unsplit: bigint; // core.marketFees(market) − feesSplit(market): spread share not yet split between holder and protocol
  shareBps: number; // seatShareBps: the holder's part of the spread share
};

/**
 * The connected account's part of the not-yet-split spread share: SeatRegistry._split credits `seatShareBps` of the
 * fresh fees to whoever holds the seat when `split` runs, so only the current holder has one.
 */
export function holderUnsplitShare(s: Pick<SeatView, "holder" | "unsplit" | "shareBps">, account: string | undefined): bigint {
  if (!account || !s.unsplit || s.holder === zeroAddress || s.holder.toLowerCase() !== account.toLowerCase()) return 0n;
  return (s.unsplit * BigInt(s.shareBps)) / 10_000n;
}

export type SeatMarket = { id: Hex; asset: Address; quote: Address; kind: Kind };

export const isVacant = (s: SeatView) => s.holder === zeroAddress;
export const BOND_BPS = 1000n;
export const bondOf = (s: SeatView) => (s.obligation * BOND_BPS) / 10_000n;

export function useSeat(m: SeatMarket | undefined) {
  const { chainId, client, deployment } = useChainCtx();
  const address = useViewAddress();
  const reg = deployment?.seatRegistry;
  return useQuery({
    queryKey: ["seat", chainId, m?.id, address],
    enabled: !!client && !!reg && !!m,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<SeatView> => {
      const [seat, obligation, mine, fees, split, shareBps] = (await readMany(client!, [
        { address: reg!, abi: seatRegistryAbi, functionName: "seatOf", args: [m!.asset, m!.quote, m!.kind] },
        { address: reg!, abi: seatRegistryAbi, functionName: "obligation", args: [m!.quote] },
        { address: reg!, abi: seatRegistryAbi, functionName: "claimable", args: [m!.quote, address ?? zeroAddress] },
        { address: deployment!.confluere, abi: confluereAbi, functionName: "marketFees", args: [m!.id] },
        { address: reg!, abi: seatRegistryAbi, functionName: "feesSplit", args: [m!.id] },
        { address: reg!, abi: seatRegistryAbi, functionName: "seatShareBps" },
      ])) as [readonly [any, bigint], bigint, bigint, bigint, bigint, number];
      const [st, taxOwed] = seat;
      return {
        holder: st.holder,
        price: st.price,
        deposit: st.deposit,
        bond: st.bond,
        lastTax: Number(st.lastTax),
        priceLockedUntil: Number(st.priceLockedUntil),
        lastQuotedBatch: Number(st.lastQuotedBatch),
        taxOwed,
        obligation,
        mine,
        unsplit: fees > split ? fees - split : 0n,
        shareBps: Number(shareBps),
      };
    },
  });
}

export function useRegistryParams() {
  const { chainId, client, deployment } = useChainCtx();
  const reg = deployment?.seatRegistry;
  return useQuery({
    queryKey: ["seat-params", chainId],
    enabled: !!client && !!reg,
    staleTime: Infinity,
    queryFn: async () => {
      const [share, tax] = (await readMany(client!, [
        { address: reg!, abi: seatRegistryAbi, functionName: "seatShareBps" },
        { address: reg!, abi: seatRegistryAbi, functionName: "taxBps" },
      ])) as [number, number];
      return { share: Number(share), tax: Number(tax) };
    },
  });
}

/** Current base batch index on the grid. */
export const currentBatch = (now: number, anchor: number, interval: number) => Math.floor((now - anchor) / interval);

/**
 * Price band an obligation order must respect, mirroring SeatRegistry.postOrder: once the pool has a clearing price, a
 * lend-side (BUY) order needs limit >= P* x (1 - band) and a borrow-side (SELL) order limit <= P* x (1 + band), with
 * the pool's own band tier. Before the first trade there is no band (a BUY then counts at min(limit, K)).
 */
export function obligationBand(lastClearingPrice: bigint, bandBps: number, lend: boolean): { min?: bigint; max?: bigint } {
  if (lastClearingPrice === 0n) return {};
  const b = BigInt(bandBps);
  return lend ? { min: (lastClearingPrice * (10_000n - b)) / 10_000n } : { max: (lastClearingPrice * (10_000n + b)) / 10_000n };
}

/**
 * Quote notional SeatRegistry.postOrder checks against the obligation: units valued at K, except a lend-side (BUY)
 * order before the pool's first trade, valued at min(limit, K), rounded down.
 */
export function obligationValue(units: bigint, limit: bigint, pool: { lastClearingPrice: bigint; strike: bigint; assetDecimals: number }, lend: boolean): bigint {
  const at = lend && pool.lastClearingPrice === 0n && limit < pool.strike ? limit : pool.strike;
  return quoteDown(units, at, scaleOf(pool.assetDecimals));
}

export function withinObligationBand(limit: bigint, band: { min?: bigint; max?: bigint }): boolean {
  return (band.min === undefined || limit >= band.min) && (band.max === undefined || limit <= band.max);
}
