import { describe, expect, it } from "vitest";
import { classOf, exitReason, isPoolClass, marketDone, quote } from "../src/rules.js";

const base = {
  cls: "main" as const,
  lastClearingPrice: 2900_000000n,
  scale: 10n ** 18n,
  perBatchQuote: 2900_000000n,
  remainingQuote: 10_000_000000n,
  competitiveDepthUnits: 0n,
  now: 100,
  endAt: 0,
};

describe("bootstrap rules", () => {
  it("bids 0.5% under the last price for main pools, 0.1% for pegged", () => {
    expect(quote(base)!.limit).toBe(2885_500000n);
    expect(quote({ ...base, cls: "pegged", lastClearingPrice: 98n * 10n ** 16n })!.limit).toBe(97902n * 10n ** 13n);
  });
  it("only fills the gap left by competitive depth", () => {
    const full = quote(base)!;
    expect(quote({ ...base, competitiveDepthUnits: full.units })).toBeNull();
    expect(quote({ ...base, competitiveDepthUnits: full.units / 2n })!.units).toBe(full.units - full.units / 2n);
  });
  it("respects the total cap, the end date and needs a reference price", () => {
    expect(quote({ ...base, remainingQuote: 0n })).toBeNull();
    expect(quote({ ...base, endAt: 50 })).toBeNull();
    expect(quote({ ...base, lastClearingPrice: 0n })).toBeNull();
  });
});

describe("bootstrap bands by pair", () => {
  // Sepolia: wstETH (Lido), WETH (Uniswap's canonical), USDC (Circle)
  const WSTETH = "0xB82381A3fBD3FaFA77B3a7bE693342618240067b";
  const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
  const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  const sepolia = { lst: WSTETH, native: WETH };
  it("quotes wstETH / WETH in the pegged band and both USDC markets in the main band", () => {
    expect(classOf(WSTETH, WETH, sepolia)).toBe("pegged");
    expect(classOf(WSTETH.toLowerCase(), WETH.toUpperCase().replace("0X", "0x"), sepolia)).toBe("pegged");
    expect(classOf(WETH, USDC, sepolia)).toBe("main");
    expect(classOf(WSTETH, USDC, sepolia)).toBe("main");
    expect(classOf(WETH, WSTETH, sepolia)).toBe("main"); // the reverse pair is not the LST loop
  });
  it("has no pegged market without an LST (HyperEVM testnet) or without pool addresses", () => {
    const ZERO = "0x0000000000000000000000000000000000000000";
    expect(classOf(ZERO, WETH, { lst: ZERO, native: WETH })).toBe("main");
    expect(classOf(WSTETH, WETH)).toBe("main");
  });
  it("prices a wstETH / WETH bid 0.1% under the last clear (about 1.0377 WETH per wstETH)", () => {
    const last = 1_037_700_000_000_000_000n;
    const q = quote({ ...base, cls: classOf(WSTETH, WETH, sepolia), lastClearingPrice: last, perBatchQuote: last })!;
    expect(q.limit).toBe((last * 9_990n) / 10_000n);
  });
  it("accepts only the two published classes from POOLS", () => {
    expect(isPoolClass("pegged") && isPoolClass("main")).toBe(true);
    expect(isPoolClass("tight") || isPoolClass("toString") || isPoolClass("__proto__")).toBe(false);
  });
});

describe("bootstrap exit (v0.8: per market, seat or weekly volume)", () => {
  const m = (seated: boolean, weeklyVolume = 0n) => ({ seated, weeklyVolume });
  const e = { now: 1_000, endAt: 0, markets: [m(true), m(false)], exitWeeklyVolume: 0n };
  it("keeps running while a market has no seat holder and no exit line, however long it ran", () => {
    expect(exitReason(e)).toBeNull();
    expect(exitReason({ ...e, now: 1_000 + 100 * 86_400 })).toBeNull();
  });
  it("exits once every market has a seat holder", () => {
    expect(exitReason({ ...e, markets: [m(true), m(true)] })).toBe("seats cover every market");
  });
  it("a market leaves once its weekly volume reaches the exit line", () => {
    expect(marketDone(m(false, 99n), 100n)).toBe(false);
    expect(marketDone(m(false, 100n), 100n)).toBe(true);
    expect(marketDone(m(false, 10n ** 30n), 0n)).toBe(false); // no line: seats only
    expect(exitReason({ ...e, markets: [m(true), m(false, 100n)], exitWeeklyVolume: 100n })).toBe(
      "every market seated or past the weekly volume line",
    );
  });
  it("no markets known does not count as covered", () => {
    expect(exitReason({ ...e, markets: [] })).toBeNull();
  });
  it("an earlier END_AT still applies", () => {
    expect(exitReason({ ...e, endAt: 900 })).toBe("END_AT reached");
  });
});
