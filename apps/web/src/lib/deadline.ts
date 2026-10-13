/**
 * When a loan must be repaid (FRONTEND_V3 §9): the maturity plus the repayment window, which counts BLOCKS. The time is
 * an estimate from the measured block time and is marked "≈"; without a block time only the maturity is known.
 */
import { Status } from "@confluere/sdk";
import type { PoolRow } from "./data";

export type Deadline = { ts: number; approx: boolean; known: boolean };

export function repayDeadline(
  p: Pick<PoolRow, "status" | "expiry" | "windowEnd" | "expiryWindowEnd">,
  o: { now: number; block: bigint; spb: number | null | undefined; windowBlocks: number },
): Deadline {
  const spb = o.spb && o.spb > 0 ? o.spb : undefined;
  const endBlock = p.status === Status.Window ? p.windowEnd : p.expiryWindowEnd;
  if (endBlock > 0n) {
    if (!spb) return { ts: p.expiry, approx: true, known: false };
    const left = endBlock > o.block ? Number(endBlock - o.block) * spb : 0;
    return { ts: Math.round(o.now + left), approx: true, known: true };
  }
  if (!spb) return { ts: p.expiry, approx: true, known: false };
  // the window starts when the first pool of the maturity is marked matured, at or shortly after the maturity
  return { ts: Math.round(Math.max(p.expiry, o.now) + o.windowBlocks * spb), approx: true, known: true };
}

/** Seconds left in an open repayment window (0 when it is over or unknown). */
export function windowLeft(p: Pick<PoolRow, "status" | "windowEnd" | "expiryWindowEnd">, block: bigint, spb: number | null | undefined): number {
  const endBlock = p.status === Status.Window ? p.windowEnd : p.expiryWindowEnd;
  if (endBlock === 0n || !spb || endBlock <= block) return 0;
  return Number(endBlock - block) * spb;
}
