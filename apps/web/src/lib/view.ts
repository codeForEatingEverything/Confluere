/**
 * Plain-word accessors over a pool row, so screens never touch protocol field names (FRONTEND_V3 §4: the words
 * strike, settle, batch, ttl stay out of components). Pure.
 *
 * - buy-back price = strike: quote per 1 whole collateral a borrower pays to get it back.
 * - last traded = lastClearingPrice: quote per 1 whole collateral a borrower received in the last round.
 * - a round = one clearing of the pool (every `batchInterval` seconds; long-tail pools are slower).
 */
import { Kind, Status, scaleOf } from "@confluere/sdk";
import type { PoolRow } from "./data";
import { isPaused, windowOpen } from "./window";

export const buyBack = (p: Pick<PoolRow, "strike">): bigint => p.strike;
export const lastTraded = (p: Pick<PoolRow, "lastClearingPrice">): bigint => p.lastClearingPrice;
export const roundsDone = (p: Pick<PoolRow, "settleCount">): number => p.settleCount;
export const roundSeconds = (p: Pick<PoolRow, "batchInterval">): number => p.batchInterval;
export const unitScale = (p: Pick<PoolRow, "assetDecimals">): bigint => scaleOf(p.assetDecimals);
export const repaysAnyTime = (p: Pick<PoolRow, "kind">): boolean => p.kind === Kind.American;
export const priceGuardBps = (p: Pick<PoolRow, "bandBps">): number => p.bandBps;
export const misses = (p: Pick<PoolRow, "bandFailures">): number => p.bandFailures;

/** Time of the next clearing after `now` (the first grid boundary still ahead). */
export function nextRoundAt(p: Pick<PoolRow, "nextBatchAt" | "batchInterval">, now: number): number {
  const iv = Math.max(1, p.batchInterval);
  if (p.nextBatchAt > now) return p.nextBatchAt;
  return p.nextBatchAt + (Math.floor((now - p.nextBatchAt) / iv) + 1) * iv;
}

/** 0..1 through the running round (for the status ring). */
export function roundProgress(p: Pick<PoolRow, "nextBatchAt" | "batchInterval">, now: number): number {
  const iv = Math.max(1, p.batchInterval);
  const left = nextRoundAt(p, now) - now;
  return Math.min(1, Math.max(0, 1 - left / iv));
}

export type PoolState = "open" | "paused" | "awaiting" | "window" | "closing" | "closed" | "none";

/** Lifecycle in user terms: open (taking orders), awaiting (matured, window not started), window, closing, closed. */
export function poolState(p: PoolRow, now: number, block: bigint): PoolState {
  if (p.status === Status.Open) {
    if (now < p.expiry) return isPaused(p, block) ? "paused" : "open";
    return windowOpen(p, now, block) ? "window" : "awaiting";
  }
  if (p.status === Status.Window) return windowOpen(p, now, block) ? "window" : "closing";
  if (p.status === Status.Closing || p.status === Status.Selling) return "closing"; // Selling: claims wait for the sale
  if (p.status === Status.Closed) return "closed";
  return "none";
}

export const takesOrders = (p: PoolRow, now: number, block: bigint) => poolState(p, now, block) === "open";

/** Significant digits a buy-back price may have on this network's grid. */
export const priceDigits = (g: { strikeSigDigits: number } | undefined, fallback = 2) => g?.strikeSigDigits ?? fallback;

/** Loop planner input in plain names. */
export const loopInput = (o: { a0: bigint; price: bigint; buyBack: bigint; rate: bigint; rounds: number; assetDecimals: number; quoteDecimals: number }) => ({
  a0: o.a0,
  pStar: o.price,
  strike: o.buyBack,
  stakeRate: o.rate,
  rounds: o.rounds,
  assetDecimals: o.assetDecimals,
  quoteDecimals: o.quoteDecimals,
});
