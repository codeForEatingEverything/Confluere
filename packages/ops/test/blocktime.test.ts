import { describe, expect, it } from "vitest";
import { windowBlocks } from "../src/blocktime";

describe("windowBlocks", () => {
  it("1 s blocks (HyperEVM small blocks): 7,200", () => {
    expect(windowBlocks(86_400, 86_400)).toBe(7200);
  });
  it("0.3 s blocks (Monad measured): 24,000", () => {
    expect(windowBlocks(288_000, 86_400)).toBe(24_000);
  });
  it("12 s slots (Ethereum Sepolia): 600, also with a few missed slots", () => {
    expect(windowBlocks(7_200, 86_400)).toBe(600);
    expect(windowBlocks(7_130, 86_400)).toBe(600);
  });
  it("rejects an empty sample", () => {
    expect(() => windowBlocks(0, 10)).toThrow();
  });
});
