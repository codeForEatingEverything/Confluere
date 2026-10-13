/**
 * WINDOW_BLOCKS calibration (ARCH 0.1): measure how many blocks a chain made over the last 24 hours and derive the
 * block count of a 2-hour repayment window. Read-only; no key needed.
 */
import { createPublicClient, http, type Chain } from "viem";

export const WINDOW_S = 2 * 3600;
export const SPAN_S = 24 * 3600;

/** Blocks in a `targetS` window at the rate observed over `blocks` blocks in `seconds`, rounded to the nearest 100. */
export function windowBlocks(blocks: number, seconds: number, targetS = WINDOW_S): number {
  if (blocks <= 0 || seconds <= 0) throw new Error("empty sample");
  return Math.round(((blocks / seconds) * targetS) / 100) * 100;
}

export async function measure(chain: Chain): Promise<{ blocks: number; seconds: number; window: number }> {
  const c = createPublicClient({ chain, transport: http() });
  const head = await c.getBlock();
  // estimate the rate from a short sample, then jump back ~24 h and measure exactly over that span
  const probe = await c.getBlock({ blockNumber: head.number - 1000n });
  const rate = 1000 / Math.max(1, Number(head.timestamp - probe.timestamp));
  const back = BigInt(Math.min(Number(head.number) - 1, Math.round(rate * SPAN_S)));
  const start = await c.getBlock({ blockNumber: head.number - back });
  const blocks = Number(back);
  const seconds = Number(head.timestamp - start.timestamp);
  return { blocks, seconds, window: windowBlocks(blocks, seconds) };
}
