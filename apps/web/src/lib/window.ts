import { Kind, Side, Status } from "@confluere/sdk";
import type { PoolRow } from "./data";

/** OrderLogic.MAX_TTL: an order lives at most this many settlements of its pool. */
export const MAX_TTL = 1000;

/** Same rule as the core: windows are aligned per expiry, and an unmatured pool past expiry shares that window. */
export function windowOpen(p: Pick<PoolRow, "status" | "windowEnd" | "expiry" | "expiryWindowEnd">, now: number, block: bigint): boolean {
  if (p.status === Status.Window) return block < p.windowEnd;
  if (p.status !== Status.Open || now < p.expiry) return false;
  return p.expiryWindowEnd === 0n || block < p.expiryWindowEnd;
}

export function canRepay(p: PoolRow, now: number, block: bigint): boolean {
  return windowOpen(p, now, block) || (p.kind === Kind.American && p.status === Status.Open && now < p.expiry);
}

export type Phase = "trading" | "awaiting" | "window" | "closing" | "selling" | "closed" | "none";

/** Lifecycle phase as the UI names it (FRONTEND_DESIGN §6.0 status language). */
export function phase(p: PoolRow, now: number): Phase {
  if (p.status === Status.Open) return now < p.expiry ? "trading" : "awaiting";
  if (p.status === Status.Window) return "window";
  // v0.8 decision B: an auto-sell pool past its window is selling its defaulted asset in the next maturity
  if (p.status === Status.Selling) return "selling";
  if (p.status === Status.Closing) return p.autoSell ? "selling" : "closing";
  if (p.status === Status.Closed) return "closed";
  return "none";
}

export const PHASE_LABEL: Record<Phase, string> = {
  trading: "Trading",
  awaiting: "Expired · awaiting maturity",
  window: "Repayment window",
  closing: "Closing",
  selling: "Selling defaulted collateral · claims open later",
  closed: "Closed",
  none: "Unknown",
};

export const isPaused = (p: PoolRow, block: bigint) => block < p.pausedUntil;

/** Block at which repayment for this pool's expiry stops (0 when no pool of the expiry has matured yet). */
export const repayDeadlineBlock = (p: PoolRow): bigint => (p.status === Status.Window ? p.windowEnd : p.expiryWindowEnd);

export type CutoffPool = Pick<PoolRow, "cadence" | "settleCount" | "status" | "expiry" | "nextBatchAt" | "batchInterval" | "pausedUntil">;
export type Cutoff = false | "window" | "due";

/**
 * The long-tail cancel cut-off, exactly as OrderLogic.cancelOrder: for a live non-bid order (deadline > settleCount)
 * in an Open long-tail pool before expiry, cancelling reverts
 * - "due": a batch boundary has passed and that batch is still unsettled (cur > lastSettledBatch, i.e. now >=
 *   nextBatchAt), unless the pool is paused (nothing can settle then, so the rule is off);
 * - "window": inside the last 1/12 of the running batch (next boundary − now <= interval / 12, integer division).
 * `nextBatchAt` is the boundary after the last settled batch; once it has passed, the running batch's boundary is
 * the first grid boundary after `now`.
 */
export function cancelCutoff(p: CutoffPool, o: { side: number; deadline: number }, now: number, block: bigint): Cutoff {
  if (p.cadence === 0 || o.side === Side.Bid || o.deadline <= p.settleCount || p.status !== Status.Open || now >= p.expiry) return false;
  const iv = p.batchInterval;
  const due = now >= p.nextBatchAt;
  if (due && block >= p.pausedUntil) return "due";
  const next = due ? p.nextBatchAt + (Math.floor((now - p.nextBatchAt) / iv) + 1) * iv : p.nextBatchAt;
  return next - now <= Math.floor(iv / 12) ? "window" : false;
}

/** Seconds until the running batch's boundary (the end of a "window" cut-off). */
export function cutoffEndsIn(p: CutoffPool, now: number): number {
  const iv = p.batchInterval;
  const next = now >= p.nextBatchAt ? p.nextBatchAt + (Math.floor((now - p.nextBatchAt) / iv) + 1) * iv : p.nextBatchAt;
  return Math.max(0, next - now);
}

/**
 * Whether R of `p` can be marked for rollover now (OrderLogic.rollover): while the old pool is Open before expiry
 * (blueprint 3.7: mark before expiry, the order clears from the expiry batch on) or while its aligned window is open.
 */
export function canRollover(p: PoolRow, now: number, block: bigint): boolean {
  return (p.status === Status.Open && now < p.expiry) || windowOpen(p, now, block);
}

/**
 * Lock state of a seat obligation order for the Cancel button, same rule as OrderLogic.cancelOrder (FLAG_LOCKED,
 * deadline > settleCount, Open, before expiry). Orders listed in SeatRegistry's Quoted events (`q`, keys
 * "poolid:orderid") are seat orders. Returns "unknown" while the scan that would tell has not answered (Cancel then
 * waits instead of offering a transaction that may revert `Locked`); a failed scan counts as not locked, since the core
 * still rejects a locked cancel with its own message. Without a seat registry nothing is locked.
 */
export function seatLockState(
  q: { data?: Set<string>; isSuccess?: boolean; isError?: boolean },
  p: Pick<PoolRow, "id" | "status" | "settleCount" | "expiry">,
  o: { id: bigint; deadline: number },
  now: number,
  hasRegistry: boolean,
): boolean | "unknown" {
  if (!hasRegistry) return false;
  if (!(o.deadline > p.settleCount && p.status === Status.Open && now < p.expiry)) return false;
  if (q.data) return q.data.has(`${p.id.toLowerCase()}:${o.id}`);
  return q.isError ? false : "unknown";
}

/** Pools whose orders may still be seat-locked (Open, before expiry): the only ones the Quoted scan has to cover. */
export const lockablePools = <P extends Pick<PoolRow, "id" | "status" | "expiry">>(pools: P[], now: number): P[] => {
  const seen = new Set<string>();
  return pools.filter((p) => p.status === Status.Open && now < p.expiry && !seen.has(p.id) && (seen.add(p.id), true));
};
