import type { Address, Hex } from "viem";
import type { Clients } from "./chain.js";
import type { Log, Tasks } from "./tasks.js";

/**
 * What a tick needs from discovery: the ids found so far, a way to look for new ones, and optionally the pools that got
 * new orders since the last tick (cleared by `tick` once handed to the tasks).
 */
export type Scanner = { pools: Set<Hex>; vaults: Set<Address>; touched?: Set<Hex>; scan(): Promise<void> };

/**
 * One keeper round. A failed log scan only delays discovering new pools: the pools and vaults already known are
 * still served this round. Returns how many transactions were sent.
 */
export async function tick(c: Clients, disc: Scanner, tasks: Tasks, log: Log): Promise<number> {
  try {
    await disc.scan();
  } catch (e) {
    log("scan failed", { error: String(e).slice(0, 200) });
  }
  const block = await c.pub.getBlock();
  const now = Number(block.timestamp);
  const a = await tasks.runPools(disc.pools, now, block.number, disc.touched);
  disc.touched?.clear();
  const b = (await tasks.runGraduation(now)) + (await tasks.runSeats(now)) + (await tasks.runVaults(disc.vaults, now));
  if (a + b > 0) log("tick", { pools: disc.pools.size, vaults: disc.vaults.size, sent: a + b });
  return a + b;
}
