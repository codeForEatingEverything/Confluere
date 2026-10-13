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
