/** Chart data (IA v3.1 item 2) and the home card's router (item 1), pure. */
import { describe, expect, it } from "vitest";
import { Kind } from "@confluere/sdk";
import { NOW, pid, row } from "./fixtures";
import { blockTime, byPool, candleSize, candles, distinctCount, fewTrades, historyOf, inRange, lockedSeries, mergeHistory, rateKind, rateRange, volumeBars, volumeSince } from "../src/lib/history";
import { routeBorrow } from "../src/lib/bestPool";
import { termsFor } from "../src/lib/product";

const E18 = 10n ** 18n;
const clock = { now: NOW, head: 1000n, spb: 2 };

describe("price history", () => {
  it("estimates a round's time from its block and the measured block time", () => {
    expect(blockTime(1000n, clock)).toBe(NOW);
    expect(blockTime(900n, clock)).toBe(NOW - 200);
    expect(blockTime(900n, { ...clock, spb: null })).toBe(NOW - 100);
  });

  it("keeps traded rounds only, oldest first, with the C price and the rate it implies", () => {
    const p = row(pid("a1"), { strike: 3000_000000n, expiry: NOW + 3 * 86400 }) as any;
    const pts = historyOf(p, [
      { index: 2, price: 2900_000000n, units: E18, nc: 0n, block: 1000n },
      { index: 1, price: 0n, units: 0n, nc: 0n, block: 950n },
      { index: 0, price: 2850_000000n, units: E18, nc: 0n, block: 900n },
    ], 6, clock);
    expect(pts.map((x) => x.price)).toEqual([2850, 2900]);
    expect(pts[1]!.period).toBeCloseTo(100 / 2900, 9);
    expect(pts[1]!.apr).toBeCloseTo(((100 / 2900) * 365) / 3, 6);
    expect(rateKind(pts, p.expiry)).toBe("apr");
    expect(rateKind(pts, NOW + 3600)).toBe("period");
  });

  it("merges maturities into one series and cuts a time range", () => {
    const a = [{ ts: NOW - 2 * 86400, price: 1, period: 0, apr: 0, pool: pid("a1"), expiry: NOW }];
    const b = [{ ts: NOW - 60, price: 2, period: 0, apr: 0, pool: pid("b1"), expiry: NOW }];
    const m = mergeHistory([b, a]);
    expect(m.map((x) => x.price)).toEqual([1, 2]);
    expect(inRange(m, "1d", NOW)).toHaveLength(1);
    expect(inRange(m, "1w", NOW)).toHaveLength(2);
    expect(inRange(m, "all", NOW)).toHaveLength(2);
  });

  it("candles: OHLC per bucket, hourly unless the data spans too little time", () => {
    const t0 = 1_800_000_000 - (1_800_000_000 % 3600);
    const c = candles([
      { ts: t0 + 10, v: 5 },
      { ts: t0 + 20, v: 7 },
      { ts: t0 + 30, v: 4 },
      { ts: t0 + 40, v: 6 },
      { ts: t0 + 3700, v: 8 },
    ], 3600);
    expect(c).toEqual([
      { t: t0, o: 5, h: 7, l: 4, c: 6, n: 4 },
      { t: t0 + 3600, o: 8, h: 8, l: 8, c: 8, n: 1 },
    ]);
    expect(candleSize([{ ts: 0 }, { ts: 6 * 3600 }])).toBe(3600);
    expect(candleSize([{ ts: 0 }, { ts: 3600 }])).toBe(900);
    expect(candleSize([{ ts: 0 }])).toBe(3600);
  });

  it("candles go both ways on an up-and-down series", () => {
    const t0 = 1_800_000_000 - (1_800_000_000 % 3600);
    const vs = [10, 10.4, 10.1, 9.7, 9.9, 10.3, 10.6, 10.2, 9.8, 10.0];
    const pts = vs.flatMap((v, i) => [{ ts: t0 + i * 3600 + 60, v }, { ts: t0 + i * 3600 + 1800, v: v + (i % 2 ? -0.2 : 0.2) }]);
    const c = candles(pts, 3600);
    expect(c.some((x) => x.c > x.o)).toBe(true);
    expect(c.some((x) => x.c < x.o)).toBe(true);
    for (const x of c) expect(x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c)).toBe(true);
  });

  it("few trades: fewer than three different prices (float noise ignored)", () => {
    expect(distinctCount([32.81, 32.81, 32.810000000001])).toBe(1);
    expect(fewTrades([{ price: 32.81 }, { price: 32.81 }, { price: 32.9 }])).toBe(true);
    expect(fewTrades([{ price: 32.81 }, { price: 32.9 }, { price: 33 }])).toBe(false);
    expect(fewTrades([])).toBe(true);
  });

  it("byPool keeps maturities apart, ordered by maturity", () => {
    const pt = (ts: number, pool: string, expiry: number) => ({ ts, price: 1, period: 0, apr: 0, pool: pool as never, expiry });
    const g = byPool(mergeHistory([[pt(5, "b", 200), pt(1, "b", 200)], [pt(3, "a", 100)]]));
    expect(g.map((x) => x.map((p) => p.ts))).toEqual([[3], [1, 5]]);
  });
});

describe("volume, locked value and rate range", () => {
  const p = (ts: number, price: number, units: number, pool = pid("a1"), expiry = NOW + 3600) => ({ ts, price, period: 0.01 * price, apr: 0.1 * price, pool, expiry, units, volume: units * price });
  it("historyOf carries the units and quote traded in each round", () => {
    const pts = historyOf(row(pid("a1")) as any, [{ index: 0, price: 2900_000000n, units: 2n * E18, nc: 0n, block: 1000n }], 6, clock);
    expect(pts[0]).toMatchObject({ units: 2, volume: 5800 });
  });
  it("volume bars add up per bucket; 24h volume counts only the last day", () => {
    const t0 = 1_800_000_000 - (1_800_000_000 % 3600);
    expect(volumeBars([p(t0 + 1, 2, 1), p(t0 + 2, 3, 1), p(t0 + 3700, 1, 5)], 3600)).toEqual([{ t: t0, v: 5 }, { t: t0 + 3600, v: 5 }]);
    expect(volumeSince([p(NOW - 90_000, 2, 1), p(NOW - 60, 3, 1)], NOW - 86_400)).toBe(3);
  });
  it("locked value: running collateral of maturities not yet matured, at each round's price", () => {
    const s = lockedSeries([p(NOW - 100, 2, 1, pid("a1"), NOW - 50), p(NOW - 40, 3, 2, pid("b1"), NOW + 100)]);
    expect(s).toEqual([{ ts: NOW - 100, v: 2 }, { ts: NOW - 40, v: 6 }]);
  });
  it("rate range: high and low over the points", () => {
    expect(rateRange([p(0, 1, 1), p(1, 3, 1)], "apr")).toEqual({ hi: 0.30000000000000004, lo: 0.1 });
    expect(rateRange([], "apr")).toBeUndefined();
  });
});

describe("home router", () => {
  const WETH = "0x00000000000000000000000000000000000000a1" as const;
  const USDC = "0x00000000000000000000000000000000000000b2" as const;
  const terms = (pools: any[]) => termsFor(pools, { asset: WETH, quote: USDC, now: NOW, block: 1000n });

  it("soonest maturity that has traded, then its cheapest pool; a maturity asked for wins", () => {
    const pools = [
      row(pid("n1"), { expiry: NOW + 3600, lastClearingPrice: 0n }), // soonest, never traded
      row(pid("a1"), { strike: 3000_000000n, lastClearingPrice: 2800_000000n }),
      row(pid("a2"), { strike: 3100_000000n, lastClearingPrice: 2950_000000n }),
      row(pid("e1"), { strike: 3050_000000n, lastClearingPrice: 2850_000000n, kind: Kind.European }),
    ];
    const r = routeBorrow(terms(pools));
    expect(r.terms).toHaveLength(2);
    expect(r.offer?.id).toBe(pid("a2"));
    expect(routeBorrow(terms(pools), NOW + 3600).offer?.id).toBe(pid("n1"));
  });

  it("at equal cost, repay-any-time beats repay-at-maturity; nothing open, no pick", () => {
    const pools = [row(pid("e1"), { kind: Kind.European }), row(pid("a1"))];
    expect(routeBorrow(terms(pools)).offer?.id).toBe(pid("a1"));
    expect(routeBorrow(terms([row(pid("z1"), { status: 4 })])).offer).toBeUndefined();
  });
});
