/** Grid helpers for the create wizard (mirror the core's rules; the core re-checks everything). */
import { isGridStrike, nextExpiry } from "@confluere/sdk";

/** Nearest on-grid strikes below and above `s` (`digits` significant digits after stripping trailing zeros). */
export function nearestGridStrikes(s: bigint, digits = 2): { lower: bigint; upper: bigint } | undefined {
  if (s <= 0n || isGridStrike(s, digits)) return undefined;
  const len = s.toString().length;
  const f = 10n ** BigInt(len - digits);
  const lower = (s / f) * f;
  return { lower, upper: lower + f };
}

/** The next `n` expiries on the grid after `now`. */
export function gridExpiries(anchor: number, period: number, now: number, n: number): number[] {
  if (period <= 0) return [];
  const first = nextExpiry(anchor, period, now);
  return Array.from({ length: Math.max(0, n) }, (_, i) => first + i * period);
}

export const FEE_TIERS = [
  { bps: 1000, label: "10% of interest" },
  { bps: 1250, label: "12.5% of interest" },
  { bps: 1500, label: "15% of interest" },
];

export const BAND_TIERS = [
  { bps: 150, label: "±1.5% (pegged)", note: "For pairs that track each other, like an LST against its native coin." },
  { bps: 800, label: "±8% (mainstream)", note: "For liquid majors against a dollar token." },
  { bps: 1500, label: "±15% (long-tail)", note: "For new or volatile assets; pair with a slower cadence." },
];
