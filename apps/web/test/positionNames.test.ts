/** C / R names (lib/vocab positionName): the one place a position token's symbol and words are made. */
import { describe, expect, it } from "vitest";
import { breakEven, maturityTag, pairNote, positionAbout, positionLine, positionName, symbolPrice } from "../src/lib/vocab";

const USDC = { symbol: "USDC", decimals: 6 };
const HYPE = { symbol: "HYPE", decimals: 18 };
const WMON = { symbol: "WMON", decimals: 18 };
// Fri 16 Oct 2026, 08:00 UTC
const FRI = Date.UTC(2026, 9, 16, 8, 0) / 1000;
const pool = (o: Partial<{ expiry: number; strike: bigint; kind: number }> = {}) => ({ expiry: FRI, strike: 34_000000n, kind: 0, ...o });

describe("position names", () => {
  it("full symbol: prefix, asset, buy-back price and quote, UTC date", () => {
    expect(positionName("ft", pool(), HYPE, USDC).symbol).toBe("C-HYPE-16OCT");
    expect(positionName("br", pool(), HYPE, USDC).symbol).toBe("R-HYPE-16OCT");
  });

  it("a decimal buy-back price keeps its digits without trailing zeros; no thousands separator", () => {
    expect(symbolPrice(31_000n, USDC)).toBe("0.031");
    expect(symbolPrice(2_500_000000n, USDC)).toBe("2500");
    expect(symbolPrice(10_620000n, USDC)).toBe("10.62");
    expect(positionName("br", pool({ strike: 31_000n }), WMON, USDC).symbol).toBe("R-WMON-16OCT");
  });

  it("-M marks a pool that repays at maturity only", () => {
    expect(positionName("br", pool({ strike: 31_000n, kind: 1 }), WMON, USDC).symbol).toBe("R-WMON-16OCT");
    expect(positionName("ft", pool({ kind: 0 }), HYPE, USDC).symbol).not.toMatch(/-M$/);
  });

  it("the time is added only when another maturity falls on the same UTC day", () => {
    const at14 = Date.UTC(2026, 9, 12, 14, 0) / 1000;
    const at15 = Date.UTC(2026, 9, 12, 15, 0) / 1000;
    const nextDay = Date.UTC(2026, 9, 13, 14, 0) / 1000;
    expect(maturityTag({ expiry: at14 }, [{ expiry: at14 }, { expiry: nextDay }])).toBe("12OCT26");
    expect(maturityTag({ expiry: at14 }, [{ expiry: at14 }, { expiry: at15 }])).toBe("12OCT26-1400");
    expect(positionName("ft", pool({ expiry: at14 }), HYPE, USDC, { all: [{ expiry: at15 }] }).symbol).toBe("C-HYPE-12OCT-1400");
    expect(positionName("br", pool({ expiry: at14, kind: 1 }), HYPE, USDC, { all: [{ expiry: at15 }] }).symbol).toBe("R-HYPE-12OCT-1400");
  });

  it("short symbol fits a wallet (11 characters) and the display names are plain words", () => {
    const n = positionName("ft", pool(), HYPE, USDC);
    expect(n.short).toBe("C-HYPE");
    expect(n.display).toBe("Lender token");
    expect(n.badge).toBe("C");
    expect(positionName("br", pool(), { symbol: "LONGTOKENNAME", decimals: 18 }, USDC).short.length).toBeLessThanOrEqual(11);
    expect(positionName("br", pool(), HYPE, USDC).display).toBe("Buy-back right");
  });

  it("line and sentences", () => {
    expect(positionLine(pool(), HYPE, USDC)).toBe("HYPE / USDC · buy back at 34 · matures 16 Oct 2026");
    expect(positionAbout("ft", pool(), HYPE, USDC, { net: 33_950000n })).toBe("Pays 33.95 USDC at maturity if the borrower buys back, otherwise 1 HYPE.");
    expect(positionAbout("br", pool(), HYPE, USDC, { until: "Fri 16 Oct, 10:00 UTC" })).toBe("Lets you buy 1 HYPE for 34.00 USDC until Fri 16 Oct, 10:00 UTC. Worth nothing after.");
    expect(positionAbout("br", pool({ kind: 1 }), HYPE, USDC, { until: "Fri 16 Oct, 10:00 UTC" })).toMatch(/between maturity and Fri 16 Oct/);
    expect(pairNote("HYPE")).toBe("Together, 1 C and 1 R come to 1 HYPE at maturity, less the protocol's share of repaid interest.");
    expect(breakEven(34_000000n, 1_850000n)).toBe(35_850000n);
  });
});
