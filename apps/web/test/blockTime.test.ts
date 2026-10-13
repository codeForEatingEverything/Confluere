/** Measured block time behind every "≈ time" of a block count (audit #2). */
import { describe, expect, it } from "vitest";
import { measureBlockTime } from "../src/lib/data";

const chain = (head: bigint, secPerBlock: number) => ({
  getBlock: async (a?: { blockNumber?: bigint }) => {
    const n = a?.blockNumber ?? head;
    return { number: n, timestamp: BigInt(Math.round(1_700_000_000 + Number(n) * secPerBlock)) };
  },
});

describe("measureBlockTime", () => {
  it("averages over the last 1000 blocks", async () => {
    expect(await measureBlockTime(chain(70_000_000n, 0.302) as any)).toBeCloseTo(0.302, 3);
    expect(await measureBlockTime(chain(66_000_000n, 1) as any)).toBe(1);
  });
  it("uses fewer blocks on a young chain and gives up when it cannot measure", async () => {
    expect(await measureBlockTime(chain(10n, 2) as any)).toBe(2);
    expect(await measureBlockTime(chain(0n, 2) as any)).toBeNull();
    expect(await measureBlockTime(chain(500n, 0) as any)).toBeNull(); // timestamps do not advance
  });
});
