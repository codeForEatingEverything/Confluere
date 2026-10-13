import { describe, expect, it } from "vitest";
import { obligationBand, withinObligationBand } from "../src/lib/seats";

// mirrors contracts/test/unit/Seats.t.sol test_postOrder_mustBeNearTheClearingPrice: P* 2900, band 8%
describe("obligationBand (SeatRegistry.postOrder rule)", () => {
  it("lend side needs limit >= P* x (1 - band)", () => {
    const b = obligationBand(2900_000000n, 800, true);
    expect(b.min).toBe(2668_000000n);
    expect(withinObligationBand(2667_000000n, b)).toBe(false);
    expect(withinObligationBand(2668_000000n, b)).toBe(true);
  });
  it("borrow side needs limit <= P* x (1 + band)", () => {
    const b = obligationBand(2900_000000n, 800, false);
    expect(b.max).toBe(3132_000000n);
    expect(withinObligationBand(3133_000000n, b)).toBe(false);
    expect(withinObligationBand(3132_000000n, b)).toBe(true);
  });
  it("no band before the first trade", () => {
    expect(obligationBand(0n, 800, true)).toEqual({});
    expect(withinObligationBand(1n, {})).toBe(true);
  });
});
