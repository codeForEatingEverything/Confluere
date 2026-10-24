/**
 * Grid helpers for the create wizard and the strike pickers (BLUEPRINT v0.8 §3.3, V08 spec §2.7). Strikes sit on a
 * 1% log grid: K(n) = 10^quoteDecimals × 1.01^n, computed with the core's exact RAY integer algorithm so the web and
 * Grid.sol agree bit for bit. A strike is valid only at its smallest index (the canonical n); the core re-checks.
 */
import { nextExpiry, strikeAt, strikeIndexOf } from "@confluere/sdk";

export const MAX_STRIKE_INDEX = 4095;

export { strikeAt, strikeIndexOf };

export const isLogGridStrike = (strike: bigint, quoteDecimals: number) => strikeIndexOf(strike, quoteDecimals) !== undefined;

function approxIndex(strike: bigint, quoteDecimals: number): number {
  const x = Number(strike) / 10 ** quoteDecimals;
  return Math.round(Math.log(x) / Math.log(1.01));
}

/** Nearest grid strikes below and above `s` (undefined when `s` is already on the grid). */
export function nearestGridStrikes(s: bigint, quoteDecimals: number): { lower: bigint; upper: bigint } | undefined {
  if (s <= 0n || isLogGridStrike(s, quoteDecimals)) return undefined;
  let n = Math.max(-MAX_STRIKE_INDEX, Math.min(MAX_STRIKE_INDEX, approxIndex(s, quoteDecimals)));
  while (n > -MAX_STRIKE_INDEX && strikeAt(n, quoteDecimals) > s) n--;
  while (n < MAX_STRIKE_INDEX && strikeAt(n + 1, quoteDecimals) <= s) n++;
  const lower = strikeAt(n, quoteDecimals);
  let m = n + 1;
  while (m < MAX_STRIKE_INDEX && strikeAt(m, quoteDecimals) === lower) m++;
  return { lower, upper: strikeAt(m, quoteDecimals) };
}

/** `count` distinct grid strikes centred on `s` (for the Borrow / Lend / Markets strike pickers). */
export function gridStrikesAround(s: bigint, quoteDecimals: number, count = 7): { n: number; strike: bigint }[] {
  if (s <= 0n) return [];
  const c = approxIndex(s, quoteDecimals);
  const out: { n: number; strike: bigint }[] = [];
  const half = Math.floor(count / 2);
  for (let n = c - half; n <= c + half; n++) {
    if (Math.abs(n) > MAX_STRIKE_INDEX) continue;
    const k = strikeAt(n, quoteDecimals);
    if (k > 0n && !out.some((o) => o.strike === k)) out.push({ n, strike: k });
  }
  return out;
}

/** The next `n` expiries on the grid after `now`. */
export function gridExpiries(anchor: number, period: number, now: number, n: number): number[] {
  if (period <= 0) return [];
  const first = nextExpiry(anchor, period, now);
  return Array.from({ length: Math.max(0, n) }, (_, i) => first + i * period);
}

export const BAND_TIERS = [
  { bps: 150, label: "±1.5% (pegged)", note: "For pairs that track each other, like an LST against its native coin." },
  { bps: 800, label: "±8% (mainstream)", note: "For liquid majors against a dollar token." },
  { bps: 1500, label: "±15% (long-tail)", note: "For new or volatile assets; pair with a slower cadence." },
];

export type AssetClass = "pegged" | "major" | "longtail";

const MAJORS = new Set(["ETH", "WETH", "BTC", "WBTC", "UBTC", "HYPE", "WHYPE", "MON", "WMON", "SOL", "USOL", "UETH", "STETH", "WSTETH", "SHMON", "KHYPE", "STHYPE"]);
const DOLLARS = /^(usd|dai|feusd)/i;

/** Asset class of a pair: pegged (two dollars, or a staked token against its own coin), major, or long-tail. */
export function assetClass(assetSymbol: string, quoteSymbol: string): AssetClass {
  const a = assetSymbol.toUpperCase();
  const q = quoteSymbol.toUpperCase();
  if (DOLLARS.test(a) && DOLLARS.test(q)) return "pegged";
  const base = q.startsWith("W") ? q.slice(1) : q;
  if (!DOLLARS.test(q) && a !== q && base.length >= 3 && a.includes(base)) return "pegged";
  if (MAJORS.has(a)) return "major";
  return "longtail";
}

/** Standard band for a pair (BLUEPRINT v0.8 §3.3: 1.5% / 8% / 15% by asset class); lists show only this tier at cadence 1×. */
export function standardBand(assetSymbol: string, quoteSymbol: string): number {
  const c = assetClass(assetSymbol, quoteSymbol);
  return c === "pegged" ? 150 : c === "major" ? 800 : 1500;
}

/** A pool is in the standard tier when its band matches the pair's class and it trades at base cadence. */
export const isStandardTier = (p: { bandBps?: number; cadence?: number }, assetSymbol: string, quoteSymbol: string) =>
  (p.bandBps === undefined || p.bandBps === standardBand(assetSymbol, quoteSymbol)) && (p.cadence ?? 0) === 0;
