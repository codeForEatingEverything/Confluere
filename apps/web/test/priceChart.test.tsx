// @vitest-environment jsdom
/**
 * The market chart draws only what the rounds say: flat testnet books show a flat line with "Few trades yet" and no
 * candles; candles are green and red; several maturities are separate price lines, never one chained rise.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PriceChart } from "../src/components/charts/PriceChart";
import type { HistPoint } from "../src/lib/history";

const NOW = 1_800_000_000;
const pt = (ts: number, price: number, pool = "0xa1", expiry = NOW + 7 * 86_400): HistPoint => ({ ts, price, period: 0.01, apr: 0.05, pool: pool as never, expiry, units: 1 + (ts % 7), volume: price * (1 + (ts % 7)) });

afterEach(cleanup);

describe("PriceChart", () => {
  it("a flat series: line only, the price, a Few trades yet note, no candle switch", () => {
    const points = Array.from({ length: 12 }, (_, i) => pt(NOW - (12 - i) * 3600, 32.81));
    render(<PriceChart points={points} expiry={NOW + 7 * 86_400} quote="USDC" now={NOW} buyBackPrice={34} />);
    const chart = screen.getByTestId("price-chart");
    expect(within(chart).getByTestId("price-chart-line")).toBeTruthy();
    expect(within(chart).getByTestId("price-chart-few").textContent).toMatch(/Few trades yet/);
    expect(within(chart).queryByRole("radio", { name: "Candles" })).toBeNull();
    expect(within(chart).getByTestId("price-chart-value").textContent).toBe("32.81 USDC");
  });

  it("an up-and-down series: candles in both colours", () => {
    const vs = [10, 10.4, 10.1, 9.7, 9.9, 10.3, 10.6, 10.2, 9.8, 10.0, 10.5, 10.1];
    const points = vs.flatMap((v, i) => [pt(NOW - (12 - i) * 3600 + 60, v), pt(NOW - (12 - i) * 3600 + 1800, v + (i % 2 ? -0.25 : 0.25))]);
    render(<PriceChart points={points} expiry={NOW + 7 * 86_400} quote="USDC" now={NOW} />);
    const chart = screen.getByTestId("price-chart");
    expect(within(chart).queryByTestId("price-chart-few")).toBeNull();
    fireEvent.click(within(chart).getByRole("radio", { name: "Candles" }));
    const dirs = within(chart).getAllByTestId("price-chart-candle").map((c) => c.getAttribute("data-dir"));
    expect(dirs).toContain("up");
    expect(dirs).toContain("down");
  });

  it("several maturities: one price line each, not chained; no candles", () => {
    const a = Array.from({ length: 6 }, (_, i) => pt(NOW - (20 - i) * 3600, 9.5 + i * 0.08, "0xa1", NOW - 10 * 3600));
    const b = Array.from({ length: 6 }, (_, i) => pt(NOW - (9 - i) * 3600, 9.2 + (i % 3) * 0.1, "0xb1", NOW + 86_400));
    render(<PriceChart points={[...a, ...b].sort((x, y) => x.ts - y.ts)} expiry={NOW + 86_400} quote="USDC" now={NOW} focusPool="0xb1" />);
    const chart = screen.getByTestId("price-chart");
    expect(within(chart).getAllByTestId("price-chart-line")).toHaveLength(1);
    expect(within(chart).getAllByTestId("price-chart-line-other")).toHaveLength(1);
    expect(within(chart).queryByRole("radio", { name: "Candles" })).toBeNull();
    expect(chart.textContent).toMatch(/One line per maturity/);
    expect(chart.textContent).toMatch(/this maturity/);
  });
});
