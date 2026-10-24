import { describe, expect, it, vi } from "vitest";
import { deployments } from "@confluere/sdk";
import { ETH_REF_CHAINS, ethLeg, ethLegPrice, spotPxToPrice } from "../src/lib/refPrice";
import { SPOT_PAIRS, coinbaseSpot, krakenLast } from "../src/lib/spot";

describe("HyperCore spotPx scaling", () => {
  it("matches the testnet reading of 2026-10-11 (HYPE/USDC, szDecimals 2)", () => {
    expect(spotPxToPrice(22_526_000n, 2)).toBeCloseTo(22.526, 6);
  });
  it("scales by 10^(8 - szDecimals)", () => {
    expect(spotPxToPrice(123_456n, 5)).toBeCloseTo(123.456, 6);
  });
});

describe("Sepolia reference legs (mainnet ETH / USD, wstETH at its own rate)", () => {
  const E = 2_380;
  const R = 1.0377;
  it("WETH / USDC is ETH / USD; USDC / WETH its inverse", () => {
    expect(ethLegPrice("eth", "usd", E, null)).toBeCloseTo(2_380, 6);
    expect(ethLegPrice("usd", "eth", E, null)).toBeCloseTo(1 / 2_380, 12);
  });
  it("wstETH / WETH is the rate alone (no off-chain price); wstETH / USDC the rate times ETH / USD", () => {
    expect(ethLegPrice("lst", "eth", null, R)).toBeCloseTo(1.0377, 9);
    expect(ethLegPrice("lst", "usd", E, R)).toBeCloseTo(2_380 * 1.0377, 6);
  });
  it("no price when a needed leg is missing", () => {
    expect(ethLegPrice("eth", "usd", null, null)).toBeNull();
    expect(ethLegPrice("lst", "eth", null, null)).toBeNull();
  });
  it("only Ethereum chains price through these legs, and only their launch tokens", () => {
    expect(ETH_REF_CHAINS).toEqual([1, 11155111]);
    expect(ethLeg(998, "0x5555555555555555555555555555555555555555")).toBeUndefined();
    // Sepolia has no deployment (launch tokens) until deployments/sepolia.json exists
    expect(ethLeg(11155111, "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238")).toBe(deployments[11155111] ? "usd" : undefined);
  });
});

describe("mainnet spot parsers (/api/ref/spot)", () => {
  it("Coinbase spot (live shape, 2026-10-23)", () => {
    expect(coinbaseSpot({ data: { amount: "2379.845", base: "ETH", currency: "USD" } })).toBeCloseTo(2379.845, 6);
    expect(coinbaseSpot({ errors: [{ id: "not_found" }] })).toBeNull();
    expect(coinbaseSpot({ data: { amount: "0" } })).toBeNull();
  });
  it("Kraken last trade (live shape, 2026-10-23)", () => {
    expect(krakenLast({ error: [], result: { XETHZUSD: { a: ["2379.89000", "3", "3.000"], c: ["2380.06000", "0.07371254"] } } })).toBeCloseTo(2380.06, 6);
    expect(krakenLast({ error: ["EQuery:Unknown asset pair"] })).toBeNull();
    expect(krakenLast(null)).toBeNull();
  });
  it("serves ETH_USD only", () => {
    expect(Object.keys(SPOT_PAIRS)).toEqual(["ETH_USD"]);
  });
  it("an inherited name (toString, __proto__, constructor) is unknown: 400, nothing asked upstream", async () => {
    const { GET } = await import("../src/app/api/ref/spot/route");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      for (const symbol of ["toString", "__proto__", "constructor", "hasOwnProperty", ""]) {
        const r = await GET(new Request(`http://x/api/ref/spot?symbol=${symbol}`));
        expect(r.status).toBe(400);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
