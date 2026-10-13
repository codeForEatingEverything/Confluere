/**
 * What is due now, for the Developers page and Operate boxes. Same pure rules as the keeper
 * (services/keeper/src/plan.ts), including the rollover-dead purge rule; copied here because the web app must not
 * change the SDK or the keeper.
 * Every action is permissionless and idempotent; a stale view only costs a reverted simulation.
 */
import { missedBatchEnd, Side, Status } from "@confluere/sdk";
import type { BookOrder, PoolRow } from "./data";
import { windowOpen } from "./window";

export type Action = "settle" | "mature" | "close" | "purge" | "none";

export function dueAction(p: Pick<PoolRow, "status" | "expiry" | "windowEnd" | "pausedUntil" | "nextBatchAt">, nowS: number, block: bigint, settleDelayS = 0): Exclude<Action, "purge"> {
  if (p.status === Status.Open) {
    if (nowS >= p.expiry) return "mature";
    if (block < p.pausedUntil) return "none";
    if (nowS >= p.nextBatchAt + settleDelayS && p.nextBatchAt < p.expiry) return "settle";
    return "none";
  }
  if (p.status === Status.Window && block >= p.windowEnd) return "close";
  if (p.status === Status.Closing) return "close";
  return "none";
}

/** Vault poke is due in the last `leadS` seconds before a batch boundary, once per batch. */
export function pokeDue(nowS: number, anchor: number, interval: number, lastPokeBatch: number, leadS: number): boolean {
  const batch = Math.floor((nowS - anchor) / interval);
  const boundary = anchor + (batch + 1) * interval;
  return batch > lastPokeBatch && boundary - nowS <= leadS;
}

/** What a rollover order's verdict depends on: its old pool (`pool(old)` plus `expiryWindowEnd(old.expiry)`). */
export type OldPool = Pick<PoolRow, "status" | "expiry" | "windowEnd" | "expiryWindowEnd">;

/** Mirrors the rollover branch of OrderLogic.purge (keeper plan.ts rolloverDead): the old window is over for good. */
export function rolloverDead(o: OldPool, nowS: number, block: bigint): boolean {
  return !windowOpen(o, nowS, block) && (o.status !== Status.Open || nowS >= o.expiry);
}

/**
 * Orders `purge` refunds: all non-bids once trading is over, otherwise those whose ttl is used up, and rollover orders
 * whose old pool's window ended (`rolloverOld` gives a rollover order's old pool; settlement only skips such an order,
 * so only a purge releases its top-up and the owner's locked R).
 */
export function deadOrders(
  orders: Pick<BookOrder, "id" | "side" | "deadline">[],
  settleCount: number,
  tradingOver: boolean,
  rolloverOld?: (id: bigint) => OldPool | undefined,
  nowS = 0,
  block = 0n,
): bigint[] {
  return orders
    .filter((o) => {
      if (o.side === Side.Bid) return false;
      if (tradingOver || o.deadline <= settleCount) return true;
      const old = rolloverOld?.(o.id);
      return !!old && rolloverDead(old, nowS, block);
    })
    .map((o) => o.id);
}

/** Old-pool lookup for poolDue: rollover sources (orderKey "poolid:orderid" → old pool id) resolved against `pools`. */
export function rolloverOldOf(pid: string, sources: Map<string, string> | undefined, pools: PoolRow[]) {
  return (id: bigint): PoolRow | undefined => {
    const old = sources?.get(`${pid.toLowerCase()}:${id}`);
    return old ? pools.find((p) => p.id.toLowerCase() === old.toLowerCase()) : undefined;
  };
}

/** Pool action including purge (when nothing else is due but the book holds dead orders). */
export function poolDue(
  p: PoolRow,
  nowS: number,
  block: bigint,
  orders?: BookOrder[],
  rolloverOld?: (id: bigint) => OldPool | undefined,
): { action: Action; dead: bigint[] } {
  const a = dueAction(p, nowS, block);
  const tradingOver = p.status !== Status.Open || nowS >= p.expiry;
  // like the keeper's runPurge: any pool with a book, including Closing / Closed (resting orders survive mature)
  const dead = orders && p.status !== Status.None ? deadOrders(orders, p.settleCount, tradingOver, rolloverOld, nowS, block) : [];
  if (a !== "none") return { action: a, dead };
  return { action: dead.length > 0 ? "purge" : "none", dead };
}

/** Evidence pool for slashing a seat holder that missed a batch (mirrors SeatRegistry.slash). */
export function slashEvidence(pools: PoolRow[], anchor: number, interval: number, lastQuotedBatch: number, nowS: number): PoolRow | undefined {
  return pools.find((p) => {
    const end = missedBatchEnd(anchor, interval, lastQuotedBatch, p.batchInterval);
    return p.status !== Status.None && end <= nowS && p.expiry >= end;
  });
}

/** Graduation check over the last four expiries: every one must have volume >= threshold and no bad flag. */
export function canGraduate(stats: { volume: bigint; bad: boolean }[], threshold: bigint, cycles = 4): boolean {
  return threshold > 0n && stats.length >= cycles && stats.slice(0, cycles).every((s) => !s.bad && s.volume >= threshold);
}
