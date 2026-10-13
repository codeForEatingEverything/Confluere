import { describe, expect, it } from "vitest";
import { spotPxToPrice } from "../src/lib/refPrice";

describe("HyperCore spotPx scaling", () => {
  it("matches the testnet reading of 2026-10-11 (HYPE/USDC, szDecimals 2)", () => {
    expect(spotPxToPrice(22_526_000n, 2)).toBeCloseTo(22.526, 6);
  });
  it("scales by 10^(8 - szDecimals)", () => {
    expect(spotPxToPrice(123_456n, 5)).toBeCloseTo(123.456, 6);
  });
});
