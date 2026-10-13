import { describe, expect, it } from "vitest";
import { kuruMid } from "../src/lib/kuru";

describe("kuruMid", () => {
  it("averages the best bid and ask from 1e18 fixed point (live MON_USDC shape)", () => {
    expect(kuruMid("26817000000000000", "26877000000000000")).toBeCloseTo(0.026847, 6);
  });
});
