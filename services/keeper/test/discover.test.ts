import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { Clients } from "../src/chain.js";
import { Discovery } from "../src/discover.js";

const CORE = "0x00000000000000000000000000000000000000c0" as Address;
const FACTORY = "0x00000000000000000000000000000000000000f0" as Address;
const P1 = `0x${"11".repeat(32)}` as Hex;
const P2 = `0x${"22".repeat(32)}` as Hex;

describe("Discovery", () => {
  it("reads new orders in the same core log query as new pools, and marks those pools touched", async () => {
    const queries: { address: Address; events?: { name: string }[] }[] = [];
    const c = {
      pub: {
        getBlockNumber: async () => 10n,
        getLogs: async (q: { address: Address; events?: { name: string }[] }) => {
          queries.push(q);
          if (q.address !== CORE) return [];
          return [
            { eventName: "PoolCreated", args: { poolId: P1 } },
            { eventName: "OrderPlaced", args: { poolId: P2 } },
          ];
        },
      },
    } as unknown as Clients;
    const d = new Discovery(c, CORE, FACTORY, 0n, 100n);
    await d.scan();
    expect(queries).toHaveLength(2);
    expect(queries.find((q) => q.address === CORE)!.events!.map((e) => e.name)).toEqual(["PoolCreated", "OrderPlaced"]);
    expect([...d.pools]).toEqual([P1]);
    expect([...d.touched]).toEqual([P2]);
  });
});
