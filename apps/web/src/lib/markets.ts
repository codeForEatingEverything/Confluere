"use client";

/** Markets: the pools of one (asset, quote, kind), laid out as expiry x strike (blueprint 3.3). */
import { useMemo } from "react";
import { marketId, Kind, Status } from "@confluere/sdk";
import type { Address, Hex } from "viem";
import { usePools, type PoolRow } from "./data";

export type Market = {
  id: Hex;
  asset: Address;
  quote: Address;
  kind: Kind;
  pools: PoolRow[]; // sorted by expiry, then strike
  graduated: boolean;
  bandBps: number;
  feeBps: number;
};

/** Anchored (pegged) pairs use the ±1.5% band: the loop wizard lists only these, and only American ones. */
export const PEGGED_BAND_BPS = 150;
export const isPegged = (m: { bandBps: number }) => m.bandBps === PEGGED_BAND_BPS;

const byPool = (a: PoolRow, b: PoolRow) => a.expiry - b.expiry || (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0);

export function groupMarkets(pools: PoolRow[]): Market[] {
  const map = new Map<string, Market>();
  for (const p of pools) {
    const id = marketId(p.asset, p.quote, p.kind);
    let m = map.get(id);
    if (!m) {
      m = { id, asset: p.asset, quote: p.quote, kind: p.kind, pools: [], graduated: p.graduated, bandBps: p.bandBps, feeBps: p.feeBps };
      map.set(id, m);
    }
    m.pools.push(p);
    m.graduated ||= p.graduated;
  }
  const out = [...map.values()];
  for (const m of out) m.pools.sort(byPool);
  // graduated markets first, then those with more pools still trading, then a stable id order
  const open = (m: Market) => m.pools.filter((p) => p.status === Status.Open).length;
  return out.sort((a, b) => Number(b.graduated) - Number(a.graduated) || open(b) - open(a) || (a.id < b.id ? -1 : 1));
}

export function useMarkets(kind?: Kind) {
  const q = usePools();
  const markets = useMemo(() => {
    const all = groupMarkets(q.data ?? []);
    return kind === undefined ? all : all.filter((m) => m.kind === kind);
  }, [q.data, kind]);
  return { ...q, markets };
}

/** Expiry rows x strike columns of a market; `cell` finds the pool at a crossing. */
export function poolsOf(m: Pick<Market, "pools">) {
  const expiries = [...new Set(m.pools.map((p) => p.expiry))].sort((a, b) => a - b);
  const strikes = [...new Set(m.pools.map((p) => p.strike))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cell = (expiry: number, strike: bigint) => m.pools.find((p) => p.expiry === expiry && p.strike === strike);
  return { expiries, strikes, cell };
}

/** Pools still taking orders (open and before expiry). */
export const tradingPools = (m: Pick<Market, "pools">, now: number) => m.pools.filter((p) => p.status === Status.Open && now < p.expiry);

export function nextBatchOf(pools: PoolRow[], now: number): number | undefined {
  const t = pools.filter((p) => p.status === Status.Open && now < p.expiry && p.nextBatchAt < p.expiry).map((p) => p.nextBatchAt);
  return t.length ? Math.min(...t) : undefined;
}

/** Latest traded pool of a market (for "last P*" summaries). */
export const lastTraded = (m: Pick<Market, "pools">) => [...m.pools].reverse().find((p) => p.lastClearingPrice > 0n);

/** Grid expiries ending before `now`, newest first: the graduation look-back. */
export function pastExpiries(anchor: number, period: number, now: number, n = 4): number[] {
  if (period <= 0) return [];
  const last = anchor + Math.floor((now - anchor) / period) * period;
  const out: number[] = [];
  for (let e = last; out.length < n && e >= anchor; e -= period) if (e < now) out.push(e);
  return out;
}

/**
 * The default list view: per pair (asset, quote), three maturities. Live maturities come first, soonest first; when
 * fewer than three are live, the most recently matured ones fill up to three. Every pool of a chosen maturity (each
 * buy-back price and repay style) is kept. `isLive` decides what still counts as open.
 */
export function latestMaturities<P extends { asset: string; quote: string; expiry: number }>(pools: P[], isLive: (p: P) => boolean, n = 3): P[] {
  const byPair = new Map<string, P[]>();
  for (const p of pools) {
    const k = `${p.asset.toLowerCase()}-${p.quote.toLowerCase()}`;
    byPair.set(k, [...(byPair.get(k) ?? []), p]);
  }
  const keep = new Set<string>();
  for (const [k, ps] of byPair) {
    const live = [...new Set(ps.filter(isLive).map((p) => p.expiry))].sort((a, b) => a - b);
    const past = [...new Set(ps.filter((p) => !isLive(p)).map((p) => p.expiry))].filter((e) => !live.includes(e)).sort((a, b) => b - a);
    for (const e of [...live, ...past].slice(0, n)) keep.add(`${k}-${e}`);
  }
  return pools.filter((p) => keep.has(`${p.asset.toLowerCase()}-${p.quote.toLowerCase()}-${p.expiry}`));
}
