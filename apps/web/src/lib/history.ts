/**
 * Price history for the market charts (IA v3.1 item 2), pure. A pool's history is the list of round prices it traded
 * at (GET /api/batches; a round with no trade has price 0 and is skipped). The index stores the block of each round,
 * not its time, so a time is estimated from the measured seconds per block: ts ≈ now − (head − block) × spb.
 *
 * Words, as on screen: the C price (the contract's C) is what a lender pays per 1 collateral (the round's price); the implied fixed rate is
 * what that price earns if the borrower buys back: (buy-back − price) / price over the time left, annualised once the
 * term is a day or longer (shorter terms show the return to maturity, like the rest of the app).
 */
import { formatUnits, type Hex } from "viem";
import type { BatchRow, PoolRow } from "./data";

export const DAY = 86_400;

export type HistPoint = {
  ts: number;
  /** Quote per 1 whole collateral, as a float (display only). */
  price: number;
  /** Return to maturity at that price, (buy-back − price) / price. */
  period: number;
  /** Annualised over the time left at that moment (0 once matured). */
  apr: number;
  pool: Hex;
  expiry: number;
  /** Collateral that changed hands in the round, in whole units (display only; 0 when unknown). */
  units?: number;
  /** Quote that changed hands in the round: units × price (display only). */
  volume?: number;
};

export type Clock = { now: number; head: bigint; spb: number | null | undefined };

/** Estimated time of a block, in chain seconds. Unknown block time: one second per block (both testnets are faster). */
export function blockTime(block: bigint, c: Clock): number {
  const spb = c.spb && c.spb > 0 ? c.spb : 1;
  const behind = c.head > block ? Number(c.head - block) : 0;
  return Math.round(c.now - behind * spb);
}

/** Traded rounds of one pool as chart points, oldest first. */
export function historyOf(pool: Pick<PoolRow, "id" | "strike" | "expiry"> & { assetDecimals?: number }, rows: BatchRow[], quoteDecimals: number, c: Clock): HistPoint[] {
  const k = Number(formatUnits(pool.strike, quoteDecimals));
  const ad = pool.assetDecimals ?? 18;
  return rows
    .filter((r) => r.price > 0n)
    .map((r) => {
      const ts = blockTime(r.block, c);
      const price = Number(formatUnits(r.price, quoteDecimals));
      const period = price > 0 ? (k - price) / price : 0;
      const left = pool.expiry - ts;
      const units = Number(formatUnits(r.units, ad));
      return { ts, price, period, apr: left > 0 ? (period * 365 * DAY) / left : 0, pool: pool.id, expiry: pool.expiry, units, volume: units * price };
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Several pools merged into one series (same buy-back price across maturities), oldest first. Each point keeps its
 * pool: the price chart draws one line per maturity (an C price converges to the buy-back price as its maturity nears,
 * so chaining maturities into one line would draw a rise that never happened). Rates, volume and locked value can be
 * read across maturities as one series.
 */
export const mergeHistory = (series: HistPoint[][]): HistPoint[] => series.flat().sort((a, b) => a.ts - b.ts);

/** Points grouped by pool (maturity), each group oldest first, groups ordered by maturity. */
export function byPool<T extends { ts: number; pool?: string; expiry?: number }>(points: T[]): T[][] {
  const m = new Map<string, T[]>();
  for (const p of points) {
    const k = p.pool ?? "";
    const xs = m.get(k);
    if (xs) xs.push(p);
    else m.set(k, [p]);
  }
  return [...m.values()].map((xs) => xs.sort((a, b) => a.ts - b.ts)).sort((a, b) => (a[0]!.expiry ?? 0) - (b[0]!.expiry ?? 0));
}

/** How many different values a series has (to 6 significant digits, so float noise does not count). */
export const distinctCount = (vs: number[]): number => new Set(vs.filter((v) => Number.isFinite(v)).map((v) => v.toPrecision(6))).size;

/**
 * Too few different prices for candles or a trend to mean anything (a testnet book that clears at the same price every
 * round): the chart shows the flat line and says "Few trades yet".
 */
export const FEW_PRICES = 3;
export const fewTrades = (points: Pick<HistPoint, "price">[]): boolean => distinctCount(points.map((p) => p.price)) < FEW_PRICES;

/** What a chart shows: the price, the implied fixed rate, the traded volume (bars) or the locked value. */
export type Metric = "price" | "rate" | "volume" | "locked";

/** The rate shown for a series: APR when the selected term runs a day or more from its first trade, else return to maturity. */
export const rateKind = (points: Pick<HistPoint, "ts">[], expiry: number): "apr" | "period" => (points.length && expiry - points[0]!.ts >= DAY ? "apr" : "period");

export const valueOf = (p: HistPoint, metric: Metric, kind: "apr" | "period") =>
  metric === "price" ? p.price : metric === "volume" ? (p.volume ?? 0) : metric === "locked" ? (p.volume ?? 0) : kind === "apr" ? p.apr : p.period;

/** Time ranges of the market charts (IA v3.1 item 9, Uniswap token page). */
export const RANGES = [
  { key: "1d", label: "1D", seconds: DAY },
  { key: "1w", label: "1W", seconds: 7 * DAY },
  { key: "1m", label: "1M", seconds: 30 * DAY },
  { key: "all", label: "All", seconds: Infinity },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

export function inRange<T extends { ts: number }>(points: T[], range: RangeKey, now: number): T[] {
  const r = RANGES.find((x) => x.key === range)!;
  return Number.isFinite(r.seconds) ? points.filter((p) => p.ts >= now - r.seconds) : points;
}

export type Candle = { t: number; o: number; h: number; l: number; c: number; n: number };

/** OHLC buckets of `bucket` seconds (aligned to the clock), oldest first; empty buckets are skipped. */
export function candles(points: { ts: number; v: number }[], bucket: number): Candle[] {
  const out: Candle[] = [];
  for (const p of [...points].sort((a, b) => a.ts - b.ts)) {
    const t = Math.floor(p.ts / bucket) * bucket;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, p.v);
      last.l = Math.min(last.l, p.v);
      last.c = p.v;
      last.n += 1;
    } else out.push({ t, o: p.v, h: p.v, l: p.v, c: p.v, n: 1 });
  }
  return out;
}

export const BUCKETS = [3600, 1800, 900, 300] as const;

/**
 * Candle size: hourly (the default), or shorter only when the data spans so little time that hourly candles would be
 * fewer than four (testnet maturities are an hour apart).
 */
export function candleSize(points: { ts: number }[]): number {
  if (points.length < 2) return 3600;
  const span = points[points.length - 1]!.ts - points[0]!.ts;
  return BUCKETS.find((b) => span / b >= 4) ?? BUCKETS[BUCKETS.length - 1]!;
}

export const bucketLabel = (s: number) => (s >= 3600 ? `${s / 3600}h` : `${s / 60}m`);

/** Volume bars: quote traded per bucket (aligned to the clock), oldest first; empty buckets skipped. */
export function volumeBars(points: Pick<HistPoint, "ts" | "volume">[], bucket: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (const p of [...points].sort((a, b) => a.ts - b.ts)) {
    const t = Math.floor(p.ts / bucket) * bucket;
    const last = out[out.length - 1];
    if (last && last.t === t) last.v += p.volume ?? 0;
    else out.push({ t, v: p.volume ?? 0 });
  }
  return out;
}

/**
 * Locked value over time, estimated from fills: the running total of collateral sold into the market's maturities
 * that had not matured yet at that moment, valued at each round's price. Repayments before maturity are not known to
 * the index, so this is an upper estimate; the Stats block shows the value read from the chain now.
 */
export function lockedSeries(points: HistPoint[]): { ts: number; v: number }[] {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const held = new Map<string, { units: number; expiry: number }>();
  return sorted.map((p) => {
    const cur = held.get(p.pool) ?? { units: 0, expiry: p.expiry };
    cur.units += p.units ?? 0;
    held.set(p.pool, cur);
    let v = 0;
    for (const h of held.values()) if (h.expiry > p.ts) v += h.units * p.price;
    return { ts: p.ts, v };
  });
}

/** Quote traded in the last 24 hours before `now`. */
export const volumeSince = (points: Pick<HistPoint, "ts" | "volume">[], since: number) => points.filter((p) => p.ts >= since).reduce((s, p) => s + (p.volume ?? 0), 0);

/** Highest and lowest implied rate in a set of points (APR or return to maturity, as the chart shows it). */
export function rateRange(points: HistPoint[], kind: "apr" | "period"): { hi: number; lo: number } | undefined {
  const xs = points.map((p) => (kind === "apr" ? p.apr : p.period)).filter((x) => Number.isFinite(x));
  return xs.length ? { hi: Math.max(...xs), lo: Math.min(...xs) } : undefined;
}
