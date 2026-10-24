import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  poolId,
  rTokenId,
  cTokenId,
  Kind,
  quoteUp,
  quoteDown,
  spreadFee,
  isGridStrike,
  rolloverTopUp,
  chainById,
  deployments,
  logRange,
  pollingOnly,
  supportedChains,
} from "../src/index.js";
import { collect, render } from "../scripts/sync-deployments.mjs";

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

describe("chains", () => {
  it("serves Ethereum Sepolia and mainnet next to Monad and HyperEVM", () => {
    expect(chainById(11155111)?.name).toBe("Sepolia");
    expect(chainById(1)?.id).toBe(1);
    expect(supportedChains.map((c) => c.id)).toEqual([10143, 998, 11155111, 143, 999, 1, 31337]);
  });
  it("polls only on HyperEVM", () => {
    expect([998, 999].every(pollingOnly)).toBe(true);
    expect([10143, 143, 11155111, 1, 31337].some(pollingOnly)).toBe(false);
  });
  it("caps getLogs at each chain's public-RPC limit", () => {
    expect(logRange(10143)).toBe(100n);
    expect(logRange(998)).toBe(1000n);
    expect(logRange(11155111)).toBe(1000n);
    expect(logRange(1)).toBe(1000n);
    expect(logRange(31337)).toBe(5000n);
  });
});

describe("deployments codegen", () => {
  const write = (dir: string, name: string, d: object) => writeFileSync(join(dir, name), JSON.stringify(d));

  it("leaves a chain without a deployments file undefined", () => {
    if (existsSync(new URL("../../../deployments/sepolia.json", import.meta.url))) return; // deployed since
    expect(deployments[11155111]).toBeUndefined();
  });
  it("picks up deployments/sepolia.json by its chainId once it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "confluere-deployments-"));
    try {
      write(dir, "monad-testnet.json", { chainId: 10143, confluere: "0x01" });
      expect(Object.keys(collect(dir))).toEqual(["10143"]);
      write(dir, "sepolia.json", { chainId: 11155111, confluere: "0x02" });
      const all = collect(dir);
      expect(Object.keys(all)).toEqual(["10143", "11155111"]);
      expect(render(all)).toContain(`"11155111": {`);
      write(dir, "sepolia-copy.json", { chainId: 11155111 });
      expect(() => collect(dir)).toThrow(/already read/);
      rmSync(join(dir, "sepolia-copy.json"));
      write(dir, "notes.json", { hello: 1 });
      expect(() => collect(dir)).toThrow(/no numeric chainId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
