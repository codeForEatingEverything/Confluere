"use client";

/**
 * Holder market for C (lender tokens, the contract's C) and R (buy-back rights, R) before maturity: the periphery PositionMarket, a plain
 * on-chain order book priced in the pool's quote token (same unit as the buy-back price: quote per 1 whole collateral).
 * Asks escrow units, bids escrow quote; a taker fills an ask or hits a bid at the offer's own price, so a take never
 * slips: the amounts sent are exact. Rounding goes against the taker (buyer pays rounded up, seller receives rounded
 * down), mirroring the contract.
 *
 *   const book = usePositionBook(pool, isR);            // best asks / bids, your own offers
 *   const plan = planTakes(book.bids, units, A.decimals); // walk the best bids
 *   tx.run(() => sellNowWrites(ctx!, { takes: plan.takes, T: "R-WHYPE" }))
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { Status, positionMarketAbi } from "@confluere/sdk";
import type { Address, Hex } from "viem";
import type { PoolRow, Token } from "./data";
import { useChainCtx } from "./data";
import { readManySafe } from "./many";
import { useDemo } from "./demo/mode";
import type { Tx, Write } from "./tx";

export type MarketOffer = {
  id: bigint;
  maker: Address;
  poolId: Hex;
  units: bigint; // still on offer
  price: bigint; // quote base units per whole collateral
  expiresAt: number; // unix seconds, 0 = until the position stops trading
  isR: boolean;
  isBid: boolean;
  escrow: bigint; // bids: quote still held
};

/** Sentences for the market's custom errors (useTx `copy`). */
export const MARKET_COPY: Record<string, string> = {
  Slippage: "The price moved before your transaction landed. Refresh and try again.",
  InvalidParams: "Someone took part of this offer first. Refresh and try again.",
  Expired: "This offer expired. Refresh to see the current ones.",
  NotTradable: "This position can no longer be traded.",
  NoOffer: "This offer is gone. Refresh to see the current ones.",
  NotMaker: "Only the account that made this offer can cancel it.",
  InvalidPool: "This pool doesn't exist on this network.",
  Locked: "Part of this R is locked in an extension and cannot move.",
};

// ------------------------------------------------------------ pure

const scaleOf = (decimals: number) => 10n ** BigInt(decimals);

/** ERC-6909 id of the position: C (C) = poolId, R (R) = poolId | 1. */
export const tokenIdOf = (poolId: Hex, isR: boolean): bigint => BigInt(poolId) | (isR ? 1n : 0n);

/** What a buyer pays for `units` at `price` (rounded up, like PositionMarket.fill). */
export const costOf = (units: bigint, price: bigint, assetDecimals: number): bigint => {
  const s = scaleOf(assetDecimals);
  return (units * price + s - 1n) / s;
};

/** What a seller receives for `units` at `price` (rounded down, like PositionMarket.hit). */
export const proceedsOf = (units: bigint, price: bigint, assetDecimals: number): bigint => (units * price) / scaleOf(assetDecimals);

/** Average price per whole collateral of a take (0 when nothing is taken). */
export const avgPrice = (quote: bigint, units: bigint, assetDecimals: number): bigint => (units === 0n ? 0n : (quote * scaleOf(assetDecimals)) / units);

export const isLive = (o: Pick<MarketOffer, "expiresAt" | "units">, now: number): boolean => o.units > 0n && (o.expiresAt === 0 || now < o.expiresAt);

/** Live offers, best first: the lowest ask or the highest bid; ties keep the older offer first. */
export function sortBest(offers: MarketOffer[], now: number): MarketOffer[] {
  return offers
    .filter((o) => isLive(o, now))
    .sort((a, b) => (a.price === b.price ? (a.id < b.id ? -1 : 1) : (a.isBid ? b.price > a.price : a.price > b.price) ? 1 : -1));
}

export type Take = { offer: MarketOffer; units: bigint; quote: bigint };
export type TakePlan = { takes: Take[]; units: bigint; quote: bigint; short: bigint; avg: bigint };

/**
 * Walk `offers` (best first, see sortBest) for up to `want` units, one take per offer, at most `maxOffers` offers (each
 * is its own transaction). Skips the caller's own offers. `quote` is what a buyer pays (asks) or a seller receives (bids).
 */
export function planTakes(offers: MarketOffer[], want: bigint, assetDecimals: number, o: { maxOffers?: number; skip?: Address } = {}): TakePlan {
  const max = o.maxOffers ?? 3;
  const skip = o.skip?.toLowerCase();
  const takes: Take[] = [];
  let left = want;
  let quote = 0n;
  for (const off of offers) {
    if (left <= 0n || takes.length >= max) break;
    if (skip && off.maker.toLowerCase() === skip) continue;
    const u = off.units < left ? off.units : left;
    if (u === 0n) continue;
    const q = off.isBid ? proceedsOf(u, off.price, assetDecimals) : costOf(u, off.price, assetDecimals);
    takes.push({ offer: off, units: u, quote: q });
    quote += q;
    left -= u;
  }
  const units = want - (left > 0n ? left : 0n);
  return { takes, units, quote, short: left > 0n ? left : 0n, avg: avgPrice(quote, units, assetDecimals) };
}

/**
 * Whether C (C) or R (R) of this pool can still change hands in the market (mirrors PositionMarket._live): C until the
 * pool is Closed (then it is collected), R while it can still be used: before expiry or until its repayment window ends.
 */
export function tradable(p: Pick<PoolRow, "status" | "expiry" | "windowEnd" | "expiryWindowEnd">, isR: boolean, now: number, block: bigint): boolean {
  if (p.status === Status.None) return false;
  if (!isR) return p.status !== Status.Closed;
  if (p.status === Status.Window) return block < p.windowEnd;
  if (p.status !== Status.Open) return false;
  if (now < p.expiry) return true;
  return p.expiryWindowEnd === 0n || block < p.expiryWindowEnd;
}

/** Unix expiry for an offer that lasts `hours` from `now` (0 hours = no expiry). */
export const offerExpiry = (now: number, hours: number): bigint => (hours > 0 ? BigInt(Math.floor(now) + Math.round(hours * 3600)) : 0n);

type RawOffer = { maker: Address; units: bigint; poolId: Hex; price: bigint; expiresAt: bigint; isR: boolean; isBid: boolean; escrow: bigint };

/** Contract tuples ([ids], [offers]) to MarketOffer rows. */
export function toOffers(ids: readonly bigint[], raw: readonly RawOffer[]): MarketOffer[] {
  return ids.map((id, i) => {
    const r = raw[i]!;
    return { id, maker: r.maker, poolId: r.poolId, units: r.units, price: r.price, expiresAt: Number(r.expiresAt), isR: r.isR, isBid: r.isBid, escrow: r.escrow };
  });
}

// ------------------------------------------------------------ reads

const REFRESH_MS = 5_000;
const PAGE = 200n;

/** Best asks and bids for one position (up to `n` each, best first) and the connected account's own open offers. */
export function usePositionBook(pool: Pick<PoolRow, "id"> | undefined, isR: boolean, n = 20) {
  const { chainId, client, deployment } = useChainCtx();
  const { address } = useConnection();
  const market = deployment?.positionMarket;
  let id: bigint | undefined;
  try {
    id = pool ? tokenIdOf(pool.id, isR) : undefined;
  } catch {
    id = undefined; // not a pool id (a malformed link)
  }
  const q = useQuery({
    queryKey: ["positionBook", chainId, market, id?.toString(), n],
    enabled: !!client && !!market && id !== undefined,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const read = (functionName: "best" | "page", args: readonly unknown[]) =>
        client!.readContract({ address: market!, abi: positionMarketAbi, functionName, args } as any) as Promise<readonly [readonly bigint[], readonly RawOffer[]]>;
      const [a, b, pa, pb] = await Promise.all([
        read("best", [id!, false, BigInt(n)]),
        read("best", [id!, true, BigInt(n)]),
        read("page", [id!, false, 0n, PAGE]),
        read("page", [id!, true, 0n, PAGE]),
      ]);
      return { asks: toOffers(a[0], a[1]), bids: toOffers(b[0], b[1]), all: [...toOffers(pa[0], pa[1]), ...toOffers(pb[0], pb[1])] };
    },
  });
  const mine = useMemo(() => (address && q.data ? q.data.all.filter((o) => o.maker.toLowerCase() === address.toLowerCase()) : []), [address, q.data]);
  return { market, asks: q.data?.asks ?? [], bids: q.data?.bids ?? [], mine, isLoading: q.isLoading, isError: q.isError, refetch: q.refetch };
}

/** Best C and R offers per pool (lowest ask, highest bid), one batched read for a whole list. Empty in the demo. */
export type BestOffers = { ftAsk?: bigint; ftBid?: bigint; brAsk?: bigint; brBid?: bigint };

export function useBestOffers(poolIds: readonly Hex[]) {
  const { chainId, client, deployment } = useChainCtx();
  const demo = useDemo();
  const market = deployment?.positionMarket;
  const key = [...poolIds].sort().join(",");
  return useQuery({
    queryKey: ["positionBest", chainId, market, key],
    enabled: !!client && !!market && !demo && poolIds.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const calls = poolIds.flatMap((id) =>
        [false, true].flatMap((isR) => [false, true].map((isBid) => ({ address: market!, abi: positionMarketAbi as readonly unknown[], functionName: "best", args: [tokenIdOf(id, isR), isBid, 1n] }))),
      );
      const res = (await readManySafe(client as never, calls)) as (readonly [readonly bigint[], readonly RawOffer[]] | undefined)[];
      const now = Math.floor(Date.now() / 1000);
      const top = (r: (typeof res)[number]) => {
        const o = r?.[1]?.[0];
        return o && o.units > 0n && (o.expiresAt === 0n || Number(o.expiresAt) > now) ? o.price : undefined;
      };
      const out: Record<string, BestOffers> = {};
      poolIds.forEach((id, i) => {
        const [ftAsk, ftBid, brAsk, brBid] = [0, 1, 2, 3].map((k) => top(res[i * 4 + k]));
        out[id.toLowerCase()] = { ftAsk, ftBid, brAsk, brBid };
      });
      return out;
    },
  });
}

// ------------------------------------------------------------ writes

export type SecondaryCtx = {
  market: Address;
  account: Address;
  ensureAllowance: Tx["ensureAllowance"];
  ensureOperator: Tx["ensureOperator"];
};

/** Context for the builders below, or undefined until wallet, deployment and market are there. */
export function useSecondaryCtx(tx: Pick<Tx, "ensureAllowance" | "ensureOperator">): SecondaryCtx | undefined {
  const { deployment } = useChainCtx();
  const { address } = useConnection();
  const market = deployment?.positionMarket;
  return useMemo(
    () => (market && address ? { market, account: address, ensureAllowance: tx.ensureAllowance, ensureOperator: tx.ensureOperator } : undefined),
    [market, address, tx.ensureAllowance, tx.ensureOperator],
  );
}

const compact = (xs: (Write | null | undefined)[]) => xs.filter((x): x is Write => !!x);
const mw = (market: Address, label: string, functionName: string, args: readonly unknown[], token?: { symbol: string; decimals: number }): Write => ({
  label,
  address: market,
  abi: positionMarketAbi,
  functionName,
  args,
  token,
  copy: MARKET_COPY,
});

/** The one-time grant that lets the market move your C and R (core setOperator), when it is missing. */
export const operatorStep = (ctx: SecondaryCtx) => ctx.ensureOperator(ctx.market, "Allow the market to move your positions");

/** Sell now: hit the planned bids, one transaction each, each for exactly the quote it pays. */
export async function sellNowWrites(ctx: SecondaryCtx, i: { takes: Take[]; T: string }): Promise<Write[]> {
  if (i.takes.length === 0) throw new Error("No bids to sell into.");
  const steps = i.takes.map((t, k) => mw(ctx.market, i.takes.length > 1 ? `Sell ${i.T} (${k + 1}/${i.takes.length})` : `Sell ${i.T}`, "hit", [t.offer.id, t.units, t.quote]));
  return compact([await operatorStep(ctx), ...steps]);
}

/** List at your price: escrow the units in the market until someone buys them or you cancel. */
export async function listWrites(ctx: SecondaryCtx, i: { poolId: Hex; isR: boolean; units: bigint; price: bigint; expiresAt?: bigint; T?: string }): Promise<Write[]> {
  if (i.units === 0n || i.price === 0n) throw new Error("Enter an amount and a price.");
  return compact([await operatorStep(ctx), mw(ctx.market, `List ${i.T ?? (i.isR ? "R" : "C")}`, "list", [i.poolId, i.isR, i.units, i.price, i.expiresAt ?? 0n])]);
}

/** Buy now: fill the planned asks, paying exactly each one's cost (one approval for the total first). */
export async function buyNowWrites(ctx: SecondaryCtx, i: { takes: Take[]; quote: Token; T: string }): Promise<Write[]> {
  if (i.takes.length === 0) throw new Error("Nothing listed to buy.");
  const total = i.takes.reduce((s, t) => s + t.quote, 0n);
  const approve = await ctx.ensureAllowance(i.quote.address, total, ctx.market, { symbol: i.quote.symbol });
  const token = { symbol: i.quote.symbol, decimals: i.quote.decimals };
  const steps = i.takes.map((t, k) => mw(ctx.market, i.takes.length > 1 ? `Buy ${i.T} (${k + 1}/${i.takes.length})` : `Buy ${i.T}`, "fill", [t.offer.id, t.units, t.quote], token));
  return compact([approve, ...steps]);
}

/** Bid: escrow quote for `units` at `price` (rounded up) so a holder can sell to you instantly. */
export async function bidWrites(
  ctx: SecondaryCtx,
  i: { poolId: Hex; isR: boolean; units: bigint; price: bigint; expiresAt?: bigint; quote: Token; assetDecimals: number; T?: string },
): Promise<Write[]> {
  if (i.units === 0n || i.price === 0n) throw new Error("Enter an amount and a price.");
  const escrow = costOf(i.units, i.price, i.assetDecimals);
  const approve = await ctx.ensureAllowance(i.quote.address, escrow, ctx.market, { symbol: i.quote.symbol });
  return compact([approve, mw(ctx.market, `Bid for ${i.T ?? (i.isR ? "R" : "C")}`, "bid", [i.poolId, i.isR, i.units, i.price, i.expiresAt ?? 0n], { symbol: i.quote.symbol, decimals: i.quote.decimals })]);
}

/** Cancel one of your offers: an ask returns its units, a bid its quote. Works in any pool state. */
export const cancelWrite = (market: Address, o: Pick<MarketOffer, "id" | "isBid">): Write =>
  mw(market, o.isBid ? "Cancel bid" : "Cancel listing", o.isBid ? "cancelBid" : "cancel", [o.id]);
