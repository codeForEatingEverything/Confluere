import { describe, expect, it } from "vitest";
import { exitReason, quote, RUN_S } from "../src/rules.js";

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

describe("bootstrap exit", () => {
  const e = { now: 1_000, startedAt: 1_000, endAt: 0, marketsSeated: [true, false] };
  it("keeps running inside eight weeks while a market has no seat holder", () => {
    expect(exitReason(e)).toBeNull();
    expect(exitReason({ ...e, now: 1_000 + RUN_S - 1 })).toBeNull();
  });
  it("exits after eight weeks from the first start, whatever END_AT says", () => {
    expect(RUN_S).toBe(56 * 86_400);
    expect(exitReason({ ...e, now: 1_000 + RUN_S, endAt: 1_000 + 2 * RUN_S })).toBe("eight weeks elapsed");
  });
  it("exits once every market has a seat holder", () => {
    expect(exitReason({ ...e, marketsSeated: [true, true] })).toBe("seats cover every market");
  });
  it("no registry (no markets known) does not count as covered", () => {
    expect(exitReason({ ...e, marketsSeated: [] })).toBeNull();
  });
  it("an earlier END_AT still applies", () => {
    expect(exitReason({ ...e, endAt: 900 })).toBe("END_AT reached");
  });
});
