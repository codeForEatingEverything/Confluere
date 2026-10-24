import { describe, expect, it } from "vitest";
import { duration, fmtAmount, fmtBlocks, fmtExpiry, fmtPrice, parseAmount, pct, vaultDisplayName } from "../src/lib/format";

const T = " ";

describe("fmtAmount", () => {
  it("four tiers: >= 1M two decimals, >= 1 up to four, < 1 six significant digits, missing as —", () => {
    expect(fmtAmount(1_234_567_891n, 3)).toBe("1,234,567.89");
    expect(fmtAmount(1_250_500_000n, 6, "USDC")).toBe(`1,250.5${T}USDC`);
    expect(fmtAmount(123_456_789n, 8)).toBe("1.2346");
    expect(fmtAmount(123_456_789n, 15)).toBe("0.000000123457");
    expect(fmtAmount(undefined, 6)).toBe("—");
    expect(fmtAmount(0n, 6)).toBe("0");
  });
  it("prices keep at least two decimals and small quote prices survive", () => {
    expect(fmtPrice(2900_000000n, 6)).toBe("2,900.00");
    expect(fmtPrice(25_000n, 6)).toBe("0.025"); // WMON/USDC strike on Monad
    expect(fmtPrice(12n * 10n ** 18n, 18)).toBe("12.00");
    expect(fmtPrice(5_000n, 6)).toBe("0.005");
  });
  it("parses user input exactly", () => {
    expect(parseAmount("1,000.5", 6)).toBe(1_000_500000n);
    expect(parseAmount("abc", 6)).toBe(0n);
  });
});

describe("time and blocks", () => {
  it("fmtBlocks converts with the measured block time and is always approximate", () => {
    expect(fmtBlocks(7200, 1)).toBe("7,200 blocks (≈ 2h)");
    expect(fmtBlocks(5120, 1)).toBe("5,120 blocks (≈ 1h 25m)");
    // demo grid on HyperEVM testnet: 300 blocks at ~0.984 s is about five minutes, not two hours
    expect(fmtBlocks(300, 0.984)).toBe("300 blocks (≈ 4m 56s)");
    expect(fmtBlocks(1000, 0.302)).toBe("1,000 blocks (≈ 5m 02s)");
    expect(fmtBlocks(1, 2)).toBe("1 block (≈ 2s)");
  });
  it("fmtBlocks shows only blocks when the block time is unknown", () => {
    expect(fmtBlocks(300, undefined)).toBe("300 blocks");
    expect(fmtBlocks(300, null)).toBe("300 blocks");
    expect(fmtBlocks(300, 0)).toBe("300 blocks");
  });
  it("duration rounds fractional seconds up (a countdown never reads short)", () => {
    expect(duration(599.999)).toBe("10m 00s");
    expect(duration(0.2)).toBe("1s");
  });
  it("fmtExpiry is UTC", () => {
    expect(fmtExpiry(Date.UTC(2026, 9, 16, 8, 0) / 1000)).toBe("Fri 16 Oct, 08:00 UTC");
  });
  it("duration under a minute shows seconds", () => {
    expect(duration(42)).toBe("42s");
    expect(duration(750)).toBe("12m 30s");
    expect(duration(0)).toBe("now");
  });
  it("pct and vault names per chain", () => {
    expect(pct(0.0333)).toBe("3.33%");
    expect(vaultDisplayName("rvNATIVE-Pegged", 10143)).toBe("rvMON-Pegged");
    expect(vaultDisplayName("rvUSD-NATIVE-Low", 998)).toBe("rvUSD-HYPE-Low");
    expect(vaultDisplayName("rvNATIVE-Pegged", 11155111)).toBe("rvETH-Pegged");
  });
});
