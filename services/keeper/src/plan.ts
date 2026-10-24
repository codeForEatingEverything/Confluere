import { Side, Status } from "@confluere/sdk";

/** The subset of PoolView the keeper decides on. */
export type PoolSnapshot = {
  asset?: `0x${string}`;
  quote?: `0x${string}`;
  kind?: number;
  batchInterval?: number; // this pool's batch length (long-tail pools batch every 12 or 48 base intervals)
  status: Status;
  expiry: number;
  windowEnd: bigint;
  pausedUntil: bigint;
  nextBatchAt: number;
  settleCount?: number;
};

export type Action = "settle" | "mature" | "close" | "none";

/**
 * Pure decision: what, if anything, this pool needs now. Every action is permissionless and idempotent, so a
 * stale snapshot can only cause a reverted simulation, never a wrong state change.
 */
export function dueAction(p: PoolSnapshot, nowS: number, block: bigint, settleDelayS: number): Action {
  if (p.status === Status.Open) {
    if (nowS >= p.expiry) return "mature";
    if (block < p.pausedUntil) return "none";
    if (nowS >= p.nextBatchAt + settleDelayS && p.nextBatchAt < p.expiry) return "settle";
    return "none";
  }
  if (p.status === Status.Window && block >= p.windowEnd) return "close";
  // Closing: segmented abandonment auction; Selling: closeWindow finalises once the autoSell order is dead (a failing
  // simulation only means the order still trades)
  if (p.status === Status.Closing || p.status === Status.Selling) return "close";
  return "none";
}

/** Vault poke is due in the last `leadS` seconds before a batch boundary, once per batch. */
export function pokeDue(nowS: number, anchor: number, interval: number, lastPokeBatch: number, leadS: number): boolean {
  const batch = Math.floor((nowS - anchor) / interval);
  const boundary = anchor + (batch + 1) * interval;
  return batch > lastPokeBatch && boundary - nowS <= leadS;
}

/**
 * A resting order as the keeper sees it (from `order(poolId, id)`). `rolloverDead` is set for rollover sells whose
 * old pool's window has ended (see `rolloverDead` below).
 */
export type BookOrder = { id: bigint; side: number; deadline: number; rolloverDead?: boolean };

/**
 * Orders `purge` will refund: every order once trading is over (matured or past expiry), otherwise those whose ttl is
 * used up, and rollover orders whose old window ended. Bids are never purged. Settlement only skips a dead rollover
 * order (State.live), it never removes it, so the keeper has to pass it to `purge` to release its top-up escrow and
 * the owner's locked R.
 */
export function deadOrders(orders: BookOrder[], settleCount: number, tradingOver: boolean): bigint[] {
  return orders
    .filter((o) => o.side !== Side.Bid && (tradingOver || o.deadline <= settleCount || o.rolloverDead === true))
    .map((o) => o.id);
}

/** What the keeper reads about a rollover order's old pool: `pool(old)` plus `expiryWindowEnd(old.expiry)`. */
export type OldPool = { status: Status; expiry: number; windowEnd: bigint; expiryWindowEnd: bigint };

/** Mirrors State.windowOpen: the old pool's repayment window is running. */
export function windowOpen(o: OldPool, nowS: number, block: bigint): boolean {
  if (o.status === Status.Window) return block < o.windowEnd;
  if (o.status !== Status.Open || nowS < o.expiry) return false;
  return o.expiryWindowEnd === 0n || block < o.expiryWindowEnd;
}

/** Mirrors the rollover branch of OrderLogic.purge: the old window is over and will not open again. */
export function rolloverDead(o: OldPool, nowS: number, block: bigint): boolean {
  return !windowOpen(o, nowS, block) && (o.status !== Status.Open || nowS >= o.expiry);
}

/**
 * For a rollover order that is still alive: the block or time at which its verdict can next change, so the keeper
 * walks the book again then even if the new pool's own state did not move.
 */
export function rolloverRecheck(o: OldPool, nowS: number, block: bigint): { block?: bigint; time?: number } {
  if (o.status === Status.Window) return { block: o.windowEnd };
  if (o.status === Status.Open && nowS < o.expiry) return { time: o.expiry };
  // past expiry, not matured yet: the window ends at the expiry's shared end block, or is not scheduled yet
  return { block: o.expiryWindowEnd !== 0n ? o.expiryWindowEnd : block + 1n };
}

/** Base batch index of a timestamp; the keeper runs its non-pool tasks at most once per batch. */
export function batchOf(nowS: number, anchor: number, interval: number): number {
  return Math.floor((nowS - anchor) / interval);
}

export { missedBatchEnd } from "@confluere/sdk";

/**
 * Whether a due batch is worth a settleBatch: only a completely empty book (SELL, BUY, NC_SELL, NC_BUY all zero) is
 * skipped. A one-sided book cannot trade (non-competitive orders also need competitive orders on both sides), but
 * settling it still matters: it advances settleCount, so ttl-limited orders (vault orders use ttl 1) expire and `purge`
 * can refund them, and it advances lastSettledBatch, which lifts the long-tail cancel cutoff (OrderLogic.cancelOrder
 * rejects cancels in a long-tail pool while a passed batch is unsettled). Skipping an empty book only saves gas (on
 * Monad every transaction pays its whole gas limit); anyone can still settle, and the core catches up on skipped
 * batches the next time it settles.
 */
export function worthSettling(sells: number, buys: number, ncSells: number, ncBuys: number): boolean {
  return sells + buys + ncSells + ncBuys > 0;
}
