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
  spreadShare,
  tradeFee,
  buyEscrow,
  buyCost,
  ncUnits,
  sellerNet,
  sellSplit,
  feeEscrowSplit,
  borrowerNetPerUnit,
  lenderCostPerUnit,
  isGridStrike,
  strikeAt,
  strikeIndexOf,
  nearestGridStrikes,
  tierKey,
  lendMinMargin,
  shortMarginShare,
  repayOutcome,
  autoSellLimit,
  missedBatchEnd,
  rolloverTopUp,
  chainById,
  deployments,
  logRange,
  pollingOnly,
  supportedChains,
} from "../src/index.js";
import { collect, render } from "../scripts/sync-deployments.mjs";

describe("ids", () => {
  it("hashes the v0.8 PoolKey (band and cadence) like PoolKeyLib.toId", () => {
    // cast keccak $(cast abi-encode 'f((address,address,uint64,uint128,uint8,uint16,uint8))' '(0x..01,0x..02,1700000000,3010966302,1,800,2)')
    const id = poolId({
      asset: "0x0000000000000000000000000000000000000001",
      quote: "0x0000000000000000000000000000000000000002",
      expiry: 1_700_000_000n,
      strike: 3_010_966_302n,
      kind: Kind.European,
      bandBps: 800,
      cadence: 2,
    });
    expect(id).toBe("0x4fa5e8d03f4abcc004dcc405bdd3858c4474e9a52a40b90a56326246ab5419aa");
    expect(tierKey(3_010_966_302n, 800, 2)).toBe(3_010_966_302n | (800n << 128n) | (2n << 144n));
  });

  it("derives C and R ids from the low bit", () => {
    const pid = poolId({
      asset: "0x0000000000000000000000000000000000000001",
      quote: "0x0000000000000000000000000000000000000002",
      expiry: 1n,
      strike: 1n,
      kind: Kind.American,
      bandBps: 150,
      cadence: 0,
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
  it("charges the 5% spread share only on interest", () => {
    expect(spreadShare(scale, 3000_000000n, 2900_000000n, scale)).toBe(5_000000n);
    expect(spreadShare(scale, 3000_000000n, 3000_000000n, scale)).toBe(0n);
    expect(spreadShare(scale, 3000_000000n, 3100_000000n, scale)).toBe(0n);
    expect(spreadShare(3n, 1000n, 999n, 1n)).toBe(0n); // 3 * 1 * 500 / 1e4 rounds down
  });
  it("charges 0.015% trade fee per side, rounded down", () => {
    expect(tradeFee(1_000_000n)).toBe(150n);
    expect(tradeFee(10_000n)).toBe(1n);
    expect(tradeFee(6_666n)).toBe(0n);
    expect(tradeFee(2900_000000n)).toBe(435000n);
  });
  it("escrows cost at limit + trade fee + 2 wei per batch", () => {
    expect(buyEscrow(scale, 2900_000000n, 3, scale)).toBe(2900_435006n);
    expect(buyEscrow(1n, 2900_000000n, 1, scale)).toBe(1n + 0n + 2n); // cost rounds up to 1 wei
    expect(buyCost(scale, 2900_000000n, scale)).toEqual({ cost: 2900_000000n, trade: 435000n, total: 2900_435000n });
  });
  it("sizes an all-in NC budget", () => {
    expect(ncUnits(1000_150000n, 2000_000000n, scale)).toBe(499_999_999_500_000_000n);
    expect(ncUnits(1n, 2000_000000n, scale)).toBe(0n);
    expect(ncUnits(2n, 2000_000000n, scale)).toBe(0n); // floor(2e6 / 1000150) = 1 -> nothing after the 1 wei reserve
    expect(ncUnits(1000n, 0n, scale)).toBe(0n);
  });
  it("splits a seller fill into gross, trade fee, spread share and net", () => {
    expect(sellSplit(scale, 2900_000000n, 3000_000000n, scale)).toEqual({ gross: 2900_000000n, trade: 435000n, spread: 5_000000n, net: 2894_565000n });
    expect(sellerNet(scale, 2900_000000n, 3000_000000n, scale)).toBe(2894_565000n);
    expect(borrowerNetPerUnit(2900_000000n, 3000_000000n, scale)).toBe(2894_565000n);
    // capped so a fill never reverts: gross 1 wei, spread would be 149999999
    expect(sellSplit(scale, 1n, 3000_000000n, scale)).toEqual({ gross: 1n, trade: 0n, spread: 1n, net: 0n });
    expect(lenderCostPerUnit(2900_000000n)).toBe(2900_435000n);
  });
  it("splits the fee escrow by repaid / filled units", () => {
    expect(feeEscrowSplit(1000n, 3n, 4n)).toEqual({ toTreasury: 750n, toLenders: 250n });
    expect(feeEscrowSplit(1000n, 1n, 3n)).toEqual({ toTreasury: 333n, toLenders: 667n });
    expect(feeEscrowSplit(1000n, 0n, 0n)).toEqual({ toTreasury: 0n, toLenders: 1000n });
  });
  it("computes the 1% log strike grid bit-identically to Grid.sol", () => {
    const v6: [number, bigint][] = [
      [0, 1_000_000n], [1, 1_010_000n], [-1, 990_099n], [-2, 980_296n], [-3, 970_590n], [-384, 21_907n],
      [434, 75_071_695n], [769, 2_104_439_470n], [773, 2_189_888_152n], [805, 3_010_966_302n],
      [806, 3_041_075_965n], [1157, 99_960_740_922n],
    ];
    for (const [n, k] of v6) {
      expect(strikeAt(n, 6)).toBe(k);
      expect(strikeIndexOf(k, 6)).toBe(n);
    }
    const v18: [number, bigint][] = [
      [-7, 932_718_054_707_135_373n], [-8, 923_483_222_482_312_251n], [-11, 896_323_717_517_805_234n],
      [-453, 11_025_992_086_967_947n],
    ];
    for (const [n, k] of v18) expect(strikeAt(n, 18)).toBe(k);
    const max = (1n << 96n) - 1n;
    expect(strikeAt(2522, 18) <= max).toBe(true);
    expect(strikeAt(2523, 18) > max).toBe(true);
    expect(isGridStrike(3_000_000_000n, 805, 6)).toBe(false);
    expect(isGridStrike(3_010_966_302n, 805, 6)).toBe(true);
    expect(strikeIndexOf(3_000_000_000n, 6)).toBeUndefined();
    // collisions at tiny strikes: only the smallest index is canonical
    let n = -1400;
    while (strikeAt(n, 6) !== strikeAt(n + 1, 6)) n++;
    expect(isGridStrike(strikeAt(n, 6), n + 1, 6)).toBe(false);
    expect(nearestGridStrikes(3_000_000_000n, 6)).toEqual({
      below: { n: 804, strike: strikeAt(804, 6) },
      above: { n: 805, strike: 3_010_966_302n },
    });
  });
  it("prices Specials margin and autoSell", () => {
    expect(lendMinMargin(scale, 2000_000000n, scale)).toBe(2400_000000n);
    expect(shortMarginShare(1n, 3n, 100n)).toBe(33n);
    expect(shortMarginShare(3n, 3n, 100n)).toBe(100n);
    expect(repayOutcome(5n, 10n, 0n, 7n, 70n)).toEqual({ assetOut: 3n, uShort: 2n, marginOut: 20n });
    expect(autoSellLimit(3_010_966_302n, 500)).toBe(2_860_417_986n);
    expect(missedBatchEnd(0, 1800, 10, 1800)).toBe(13 * 1800);
    expect(missedBatchEnd(0, 1800, 10, 1800, 1)).toBe(12 * 1800);
  });
  it("matches the rollover top-up rule", () => {
    expect(rolloverTopUp(scale, 3000_000000n, 2850_000000n, 500, scale)).toBe(150_000000n + 427500n + 7_500000n + 2000n);
    expect(rolloverTopUp(scale, 3000_000000n, 2850_000000n, 1, scale, 3100_000000n)).toBe(150_000000n + 427500n + 12_500000n + 4n);
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
