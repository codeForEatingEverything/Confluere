"use client";

/**
 * LP slots (IA v3.1 item 8). One LP slot per market (asset, quote, repay style): in the contracts it is a SeatRegistry
 * seat, a Harberger-tax position. Words on screen, mapped to the contract:
 *
 * - your price = the self-assessed seat price; anyone can take the slot over by paying it to you;
 * - prepaid tax = the seat deposit; the yearly tax (`taxBps` of your price) is taken from it every second;
 * - bond = 10% of the market's per-round minimum order, returned on exit, 20% of it lost on a missed round;
 * - LP token = the non-transferable `SeatLPToken` (cLP-asset-quote), balance = prepaid tax left + bond.
 *
 * Pure helpers first, then the hooks that read every market's slot in one multicall.
 */
import { useQuery } from "@tanstack/react-query";
import { useWatchAsset } from "wagmi";
import { zeroAddress, type Address, type Hex } from "viem";
import { confluereAbi, seatRegistryAbi, type Deployment, type Kind } from "@confluere/sdk";
import { readMany } from "./many";
import { REFRESH_MS, useChainCtx } from "./data";
import type { SeatMarket, SeatView } from "./seats";
import { useViewAddress } from "./demo/hooks";

export const YEAR = 365 * 86_400;
export const COOLDOWN_S = 7 * 86_400;

/** The LP token of a market from the deployment (`seatLPTokens`, keyed `asset-quote-kind`, any case). */
export function lpTokenOf(d: Pick<Deployment, "seatLPTokens"> | undefined, m: { asset: string; quote: string; kind: number }): Address | undefined {
  const map = d?.seatLPTokens;
  if (!map) return undefined;
  const want = `${m.asset}-${m.quote}-${m.kind}`.toLowerCase();
  const hit = Object.entries(map).find(([k]) => k.toLowerCase() === want);
  return hit?.[1];
}

/** The LP token's symbol, as the contract builds it. */
/** The LP token's on-chain name, "cLP-WHYPE-USDC": pass tokens (their contract symbol is used) or symbols. */
type Sym = string | { symbol: string; onchainSymbol?: string } | undefined;
const raw = (x: Sym) => (typeof x === "string" ? x : (x?.onchainSymbol ?? x?.symbol ?? ""));
export const lpSymbol = (asset: Sym, quote: Sym) => `cLP-${raw(asset)}-${raw(quote)}`;

/** Yearly tax on a declared price. */
export const yearlyTax = (price: bigint, taxBps: number) => (price * BigInt(taxBps)) / 10_000n;

/** Seconds a prepaid tax lasts at a price (Infinity when nothing is charged). */
export function secondsCovered(deposit: bigint, price: bigint, taxBps: number): number {
  const y = yearlyTax(price, taxBps);
  if (y === 0n) return Infinity;
  return Number((deposit * BigInt(YEAR)) / y);
}

export type ZapIn = {
  /** Paid to the current LP (their declared price); 0 while the slot is free. */
  toHolder: bigint;
  bond: bigint;
  deposit: bigint;
  total: bigint;
  /** LP token balance right after: prepaid tax + bond. */
  lpBalance: bigint;
  yearly: bigint;
  /** How long the prepaid tax lasts at the new price, in seconds. */
  lasts: number;
};

/** What taking the slot costs: SeatRegistry.buy pulls price-to-holder + deposit + bond in one transfer. */
export function zapInQuote(s: Pick<SeatView, "holder" | "price" | "obligation">, price: bigint, deposit: bigint, taxBps: number): ZapIn {
  const toHolder = s.holder === zeroAddress ? 0n : s.price;
  const bond = (s.obligation * 1000n) / 10_000n;
  return { toHolder, bond, deposit, total: toHolder + deposit + bond, lpBalance: deposit + bond, yearly: yearlyTax(price, taxBps), lasts: secondsCovered(deposit, price, taxBps) };
}

/** What exiting returns: prepaid tax left + bond (SeatRegistry.release), then the withdrawal moves it to the wallet. */
export const exitReturn = (s: Pick<SeatView, "deposit" | "bond">) => s.deposit + s.bond;

/** Whether a new price is allowed now: lowering is blocked for 7 days after taking the slot. */
export const priceLocked = (s: Pick<SeatView, "price" | "priceLockedUntil">, next: bigint, now: number) => next < s.price && now < s.priceLockedUntil;

export const isMine = (s: Pick<SeatView, "holder"> | undefined, account: string | undefined) => !!s && !!account && s.holder !== zeroAddress && s.holder.toLowerCase() === account.toLowerCase();

/** Every market's slot in one multicall, keyed by market id (same shape as `useSeat`). */
export function useSeats(markets: SeatMarket[]) {
  const { chainId, client, deployment } = useChainCtx();
  const address = useViewAddress();
  const reg = deployment?.seatRegistry;
  const ids = markets.map((m) => m.id);
  return useQuery({
    queryKey: ["seats", chainId, ids, address],
    enabled: !!client && !!reg && markets.length > 0,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<Record<string, SeatView>> => {
      const head = (await readMany(client!, [
        { address: reg!, abi: seatRegistryAbi, functionName: "seatShareBps" },
      ])) as [number];
      const per = 5;
      const r = await readMany(
        client!,
        markets.flatMap((m) => [
          { address: reg!, abi: seatRegistryAbi, functionName: "seatOf", args: [m.asset, m.quote, m.kind] } as const,
          { address: reg!, abi: seatRegistryAbi, functionName: "obligation", args: [m.quote] } as const,
          { address: reg!, abi: seatRegistryAbi, functionName: "claimable", args: [m.quote, address ?? zeroAddress] } as const,
          { address: deployment!.confluere, abi: confluereAbi, functionName: "marketFees", args: [m.id] } as const,
          { address: reg!, abi: seatRegistryAbi, functionName: "feesSplit", args: [m.id] } as const,
        ]),
      );
      const out: Record<string, SeatView> = {};
      markets.forEach((m, i) => {
        const [st, taxOwed] = r[per * i] as readonly [any, bigint];
        const fees = r[per * i + 3] as bigint;
        const split = r[per * i + 4] as bigint;
        out[m.id] = {
          holder: st.holder,
          price: st.price,
          deposit: st.deposit,
          bond: st.bond,
          lastTax: Number(st.lastTax),
          priceLockedUntil: Number(st.priceLockedUntil),
          lastQuotedBatch: Number(st.lastQuotedBatch),
          taxOwed,
          obligation: r[per * i + 1] as bigint,
          mine: r[per * i + 2] as bigint,
          unsplit: fees > split ? fees - split : 0n,
          shareBps: Number(head[0]),
        };
      });
      return out;
    },
  });
}

/** The LP token icon as an absolute URL (served by /api/lp-icon), for wallet_watchAsset. */
export function lpIconUrl(chainId: number, asset: string, quote: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/api/lp-icon?chain=${chainId}&asset=${asset}&quote=${quote}`;
}

/** "Add to wallet" for an LP token (wallet_watchAsset), with the stacked-pair icon. A rejection is silent. */
export function useAddLpToWallet() {
  const w = useWatchAsset();
  const { chainId } = useChainCtx();
  return {
    pending: w.isPending,
    added: w.isSuccess,
    add: (o: { token: Address; asset: string; quote: string; assetAddress: string; quoteAddress: string; decimals: number }) =>
      w.mutate({ type: "ERC20", options: { address: o.token, symbol: lpSymbol(o.asset, o.quote), decimals: o.decimals, image: lpIconUrl(chainId, o.assetAddress, o.quoteAddress) } } as never),
  };
}

export type LpMarket = SeatMarket & { pools: { id: Hex }[] };
export type { Kind };
