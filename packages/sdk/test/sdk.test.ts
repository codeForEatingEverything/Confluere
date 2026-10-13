import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { poolId, rTokenId, cTokenId, Kind, quoteUp, quoteDown, spreadFee, isGridStrike, rolloverTopUp } from "../src/index.js";

describe("ids", () => {
  it("matches the pool ids the contracts created on anvil", () => {
    const f = new URL("../../../deployments/anvil.json", import.meta.url);
    if (!existsSync(f)) return; // only when a local deployment exists
    const d = JSON.parse(readFileSync(f, "utf8"));
    // CreatePools order: pair (lst/native, native/usdc) x strike (2) x kind (2)
    const id = poolId({
      asset: d.pools.lst,
      quote: d.pools.native,
      expiry: BigInt(d.pools.expiry),
      strike: 98n * 10n ** 16n,
      kind: Kind.American,
    });
    expect(id).toBe(d.pools.poolIds[0]);
    const id7 = poolId({
      asset: d.pools.native,
      quote: d.pools.usdc,
      expiry: BigInt(d.pools.expiry),
      strike: 30_000_000n,
      kind: Kind.European,
    });
    expect(id7).toBe(d.pools.poolIds[7]);
  });

  it("derives C and R ids from the low bit", () => {
    const pid = poolId({
      asset: "0x0000000000000000000000000000000000000001",
      quote: "0x0000000000000000000000000000000000000002",
      expiry: 1n,
      strike: 1n,
      kind: Kind.American,
    });
    expect(cTokenId(pid) & 1n).toBe(0n);
    expect(rTokenId(pid)).toBe(cTokenId(pid) + 1n);
  });
});

describe("math", () => {
  const scale = 10n ** 18n;
  it("rounds buyers up and sellers down by at most 1", () => {
    expect(quoteUp(1n, 3n, 2n) - quoteDown(1n, 3n, 2n)).toBe(1n);
  });
  it("charges the spread share only on interest", () => {
    expect(spreadFee(scale, 3000_000000n, 2900_000000n, 1000, scale)).toBe(10_000000n);
    expect(spreadFee(scale, 3000_000000n, 3100_000000n, 1000, scale)).toBe(0n);
  });
  it("knows the strike grid", () => {
    expect(isGridStrike(3000_000000n)).toBe(true);
    expect(isGridStrike(3150_000000n)).toBe(false);
    expect(isGridStrike(98n * 10n ** 16n)).toBe(true);
  });
  it("matches the rollover top-up rule", () => {
    expect(rolloverTopUp(scale, 3000_000000n, 2850_000000n, 500, scale)).toBe(150_000000n + 1000n);
  });
});
