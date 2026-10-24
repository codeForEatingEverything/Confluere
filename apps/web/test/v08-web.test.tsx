import { describe, expect, it } from "vitest";
import { Kind, Status } from "@confluere/sdk";
import { assetClass, gridStrikesAround, isLogGridStrike, nearestGridStrikes, standardBand, strikeAt, strikeIndexOf } from "@/lib/grid";
import { canLend, lendDeadline, loanState, marginOut, minMargin, shortRepay } from "@/lib/specials";
import { phase, PHASE_LABEL } from "@/lib/window";
import type { PoolRow } from "@/lib/data";

describe("1% log grid (V08 spec §2.7 vectors)", () => {
  it("matches the core's integer algorithm", () => {
    const v: [number, number, bigint][] = [
      [0, 6, 1_000_000n],
      [1, 6, 1_010_000n],
      [-1, 6, 990_099n],
      [-384, 6, 21_907n],
      [769, 6, 2_104_439_470n],
      [805, 6, 3_010_966_302n],
      [1157, 6, 99_960_740_922n],
      [-7, 18, 932_718_054_707_135_373n],
      [-453, 18, 11_025_992_086_967_947n],
    ];
    for (const [n, d, k] of v) {
      expect(strikeAt(n, d)).toBe(k);
      expect(strikeIndexOf(k, d)).toBe(n);
    }
  });
  it("rejects off-grid strikes and offers the neighbours", () => {
    expect(isLogGridStrike(3_000_000_000n, 6)).toBe(false);
    const near = nearestGridStrikes(3_000_000_000n, 6)!;
    expect(near.lower).toBe(strikeAt(804, 6));
    expect(near.upper).toBe(strikeAt(805, 6));
    expect(nearestGridStrikes(strikeAt(805, 6), 6)).toBeUndefined();
    const around = gridStrikesAround(3_000_000_000n, 6, 5);
    expect(around.length).toBe(5);
    expect(around.every((s) => isLogGridStrike(s.strike, 6))).toBe(true);
  });
  it("standard band by asset class", () => {
    expect(standardBand("wstETH", "WETH")).toBe(150);
    expect(standardBand("shMON", "WMON")).toBe(150);
    expect(standardBand("USDC", "USDT0")).toBe(150);
    expect(standardBand("WETH", "USDC")).toBe(800);
    expect(standardBand("WHYPE", "USDT0")).toBe(800);
    expect(assetClass("PURR", "USDC")).toBe("longtail");
    expect(standardBand("PURR", "USDC")).toBe(1500);
  });
});

describe("Specials (decision A)", () => {
  const S = 10n ** 18n;
  it("120% margin, rounded up", () => {
    expect(minMargin(S, 3_000_000_000n, S)).toBe(3_600_000_000n);
    expect(minMargin(1n, 1n, S)).toBe(1n);
  });
  it("only European pools before the deadline lend", () => {
    const p = { kind: Kind.European, expiry: 1_000_000, lastClearingPrice: 1n, assetBal: 5n };
    expect(canLend(p, lendDeadline(p.expiry) - 1)).toBe(true);
    expect(canLend(p, lendDeadline(p.expiry))).toBe(false);
    expect(canLend({ ...p, kind: Kind.American }, 0)).toBe(false);
    expect(loanState({ units: 1n }, p.expiry, lendDeadline(p.expiry))).toBe("overdue");
    expect(loanState({ units: 0n }, p.expiry, 0)).toBe("closed");
  });
  it("partial return releases margin pro rata", () => {
    expect(marginOut({ units: 4n, margin: 10n }, 1n)).toBe(2n);
    expect(marginOut({ units: 4n, margin: 10n }, 4n)).toBe(10n);
  });
  it("short pool: asset first, then K back plus margin share", () => {
    const r = shortRepay(3n * S, { assetAvailable: S, shortUnits: 4n * S, shortMargin: 4_000n, strike: 1_000n }, S);
    expect(r).toEqual({ asset: S, quoteBack: 2_000n, compensation: 2_000n });
  });
});

describe("auto-sell status", () => {
  it("an auto-sell pool past its window reads as selling", () => {
    const p = { status: Status.Closing, autoSell: true } as unknown as PoolRow;
    expect(phase(p, 0)).toBe("selling");
    expect(PHASE_LABEL.selling).toMatch(/claims open later/);
    expect(phase({ ...p, autoSell: false }, 0)).toBe("closing");
  });
});
