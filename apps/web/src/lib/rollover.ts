/**
 * Roll-over rules (pure): move a loan into a later maturity of the same pair before it ends (blueprint 3.7). The
 * collateral stays in the contract; the new pool's lenders pay the old buy-back price, plus a top-up the borrower
 * escrows for the gap. Marked before maturity it waits and clears from the maturity batch on; it can also be marked
 * inside the window.
 */
import { Status, rolloverTopUp, scaleOf } from "@confluere/sdk";
import type { PoolRow } from "./data";
import { MAX_TTL } from "./window";

/** Floor of the rollover ttl (settlements of the target pool). */
export const ROLLOVER_TTL = 200;
/** Spare batches on top of the computed count (settlement catching up, rounding). */
export const TTL_SLACK = 4;

/** Batches the roll-over gets to fill while the old window is open (windowBlocks × s/block / target interval). */
export function rolloverTries(windowBlocks: number, spb: number | null | undefined, targetInterval: number): number | undefined {
  if (!spb || spb <= 0 || targetInterval <= 0) return undefined;
  return Math.max(1, Math.floor((windowBlocks * spb) / targetInterval));
}

/** ttl for a roll-over marked now: batches until maturity plus the window's tries, within [ROLLOVER_TTL, MAX_TTL]. */
export function rolloverTtl(o: { now: number; fromExpiry: number; targetInterval: number; tries?: number }): { ttl: number; capped: boolean } {
  const before = Math.max(0, Math.ceil((o.fromExpiry - o.now) / o.targetInterval));
  const need = before + (o.tries ?? 0) + TTL_SLACK;
  return { ttl: Math.min(MAX_TTL, Math.max(ROLLOVER_TTL, need)), capped: need > MAX_TTL };
}

/** Later open pools of the same pair and kind, soonest maturity first, then lowest buy-back price. */
export function rolloverTargets(from: PoolRow, pools: PoolRow[]): PoolRow[] {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return pools
    .filter((p) => eq(p.asset, from.asset) && eq(p.quote, from.quote) && p.kind === from.kind && p.expiry > from.expiry && p.status === Status.Open)
    .sort((a, b) => a.expiry - b.expiry || (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
}

/** The default target: same buy-back price in the next maturity if it exists, else the next maturity's nearest one. */
export function defaultRolloverTarget(from: PoolRow, pools: PoolRow[]): PoolRow | undefined {
  const t = rolloverTargets(from, pools);
  if (t.length === 0) return undefined;
  const next = t.filter((p) => p.expiry === t[0]!.expiry);
  const dist = (p: PoolRow) => (p.strike > from.strike ? p.strike - from.strike : from.strike - p.strike);
  return [...next].sort((a, b) => (dist(a) < dist(b) ? -1 : dist(a) > dist(b) ? 1 : 0))[0];
}

/** Most the borrower may have to add (unused part refunded to Withdraw): gap between old buy-back and the floor. */
export const rolloverMaxTopUp = (from: PoolRow, units: bigint, minPrice: bigint, ttl: number) =>
  rolloverTopUp(units, from.strike, minPrice, ttl, scaleOf(from.assetDecimals));
