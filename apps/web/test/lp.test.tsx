// @vitest-environment jsdom
/** LP (IA v3.1 item 8): a list of LP pools, a market page with chart + Stats, and the zap card (Zap in, Manage, Zap out). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { marketId } from "@confluere/sdk";
import { DS, E18, ME, NOW, OTHER, ZERO, pid, resetDS, row, txMock, wrap } from "./fixtures";

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", async () => {
  const { DS } = await import("./fixtures");
  return { usePathname: () => "/lp", useSearchParams: () => new URLSearchParams(DS.search ?? ""), useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }) };
});
vi.mock("wagmi", async () => (await import("./fixtures")).wagmiModule);
vi.mock("@/lib/tx", async () => (await import("./fixtures")).txModule);
vi.mock("@/lib/data", async () => (await import("./fixtures")).dataMock());
vi.mock("@/lib/position", async () => (await import("./fixtures")).positionMock());
vi.mock("@/lib/activeChain", async () => (await import("./fixtures")).activeChainMock());
vi.mock("@/lib/allowance", async () => (await import("./fixtures")).allowanceMock());
vi.mock("@/lib/refPrice", async () => (await import("./fixtures")).refPriceMock());
vi.mock("@/lib/seats", async () => (await import("./fixtures")).seatsMock());
vi.mock("@/lib/lp", async (orig) => {
  const { DS } = await import("./fixtures");
  return { ...(await orig()), useSeats: () => ({ data: DS.seat ? { [DS.mid]: DS.seat } : undefined }) };
});

import { LpScreen } from "../src/components/lp/LpScreen";
import { LpPositions } from "../src/components/lp/LpPositions";
import { lpTokenOf, secondsCovered, zapInQuote } from "../src/lib/lp";
import { lockedNow } from "../src/lib/marketStats";

const WETH = "0x00000000000000000000000000000000000000a1";
const USDC = "0x00000000000000000000000000000000000000b2";
const MID = marketId(WETH, USDC, 0);
const vacant = { holder: ZERO, price: 0n, deposit: 0n, bond: 0n, lastTax: 0, priceLockedUntil: 0, lastQuotedBatch: 0, taxOwed: 0n, obligation: 1000_000000n, mine: 0n, unsplit: 0n, shareBps: 3500 };

beforeEach(() => {
  resetDS();
  DS.mid = MID;
  DS.pools = [row(pid("a1"), { quoteBal: 500_000000n, assetBal: 2n * E18 })];
  DS.seat = { ...vacant };
  DS.balances = { [WETH]: 10n * E18, [USDC]: 100_000_000000n };
  DS.batches = [
    { index: 2, price: 2900_000000n, units: E18, nc: 0n, block: 990n },
    { index: 1, price: 2880_000000n, units: E18, nc: 0n, block: 900n },
  ];
});
afterEach(cleanup);

describe("LP list", () => {
  it("one LP pool per market: pair icons with the LP badge, price or free, holder, locked value, where earnings come from", () => {
    wrap(<LpScreen />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("LP");
    const r = screen.getAllByTestId("lp-pools-row");
    expect(r).toHaveLength(1);
    expect(within(r[0]!).getByTestId("lp-icon").textContent).toMatch(/LP$/);
    expect(r[0]!.textContent).toMatch(/WETH \/ USDC/);
    expect(r[0]!.textContent).toMatch(/Free to take/);
    expect(r[0]!.textContent).toMatch(/35% of protocol income/);
    expect(within(r[0]!).getByRole("button", { name: "Zap in" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/seat|obligation|slash|Harberger/i);
  });
});

describe("LP market page", () => {
  it("chart (price, volume, locked value; 1D/1W/1M/All) and Stats on the left, the zap card on the right", () => {
    DS.search = `market=${MID}`;
    wrap(<LpScreen />);
    const d = screen.getByTestId("lp-drawer");
    const chart = within(d).getByTestId("lp-chart");
    for (const n of ["Price", "Volume", "Locked value"]) expect(within(chart).getByRole("radio", { name: n })).toBeTruthy();
    for (const n of ["1D", "1W", "1M", "All"]) expect(within(chart).getByRole("radio", { name: n })).toBeTruthy();
    const stats = within(d).getByTestId("lp-stats").textContent!;
    for (const k of ["Locked value", "24h volume", "Current rate", "High / low rate", "LP price", "Holder", "Tax rate", "Bond"]) expect(stats).toContain(k);
    expect(stats).toMatch(/Tax rate10% a year/);
    expect(stats).toMatch(/Bond100\.00 USDC/);
    expect(within(d).getByTestId("lp-explainer").textContent).toMatch(/Anyone can take the slot over at any time by paying you that price/);
  });

  it("zap in: your price and what you put in give the LP token and a payment breakdown; one button", async () => {
    DS.search = `market=${MID}`;
    const run = vi.spyOn(txMock, "run");
    wrap(<LpScreen />);
    const card = screen.getByTestId("zap-card");
    const btn = () => within(card).getByTestId("zap-in-button");
    expect(btn().textContent).toBe("Enter your price");
    fireEvent.change(within(card).getByTestId("zap-price"), { target: { value: "500" } });
    expect(btn().textContent).toBe("Enter an amount");
    fireEvent.change(within(card).getByTestId("zap-deposit"), { target: { value: "50" } });
    expect(within(card).getByTestId("zap-receive").textContent).toMatch(/150\.00.*cLP-WETH-USDC/);
    const b = within(card).getByTestId("zap-breakdown").textContent!;
    expect(b).toMatch(/Nothing, the slot is free/);
    expect(b).toMatch(/You pay150\.00 USDC/);
    expect(b).toMatch(/Tax at your price50\.00 USDC a year/);
    expect(btn().textContent).toBe("Zap in");
    fireEvent.click(btn());
    const writes = await (run.mock.calls[0]![0] as () => Promise<{ label: string; functionName: string; args: unknown[] }[]>)();
    expect(writes.map((w) => w.label)).toEqual(["Zap in"]);
    expect(writes[0]!.functionName).toBe("buy");
    expect(writes[0]!.args.slice(3)).toEqual([500_000000n, 50_000000n, 0n]);
    run.mockRestore();
  });

  it("taking over a held slot pays the holder's price; your own slot opens on Manage, with the LP token and Zap out", async () => {
    DS.search = `market=${MID}`;
    DS.seat = { ...vacant, holder: OTHER, price: 400_000000n, deposit: 30_000000n, bond: 100_000000n };
    const first = wrap(<LpScreen />);
    fireEvent.change(screen.getByTestId("zap-price"), { target: { value: "500" } });
    fireEvent.change(screen.getByTestId("zap-deposit"), { target: { value: "50" } });
    expect(screen.getByTestId("zap-breakdown").textContent).toMatch(/You pay550\.00 USDC/);
    first.unmount();

    DS.seat = { ...vacant, holder: ME, price: 400_000000n, deposit: 30_000000n, bond: 100_000000n, priceLockedUntil: NOW + 86400 };
    const run = vi.spyOn(txMock, "run");
    wrap(<LpScreen />);
    expect(screen.getByTestId("zap-manage")).toBeTruthy();
    expect(screen.getByTestId("lp-position").textContent).toMatch(/130\.00 cLP-WETH-USDC/);
    expect(screen.getByTestId("lp-order")).toBeTruthy();
    fireEvent.click(screen.getByTestId("zap-out-tab"));
    expect(screen.getByTestId("zap-out-total").textContent).toMatch(/130\.00 USDC/);
    fireEvent.click(screen.getByTestId("zap-out-button"));
    const writes = run.mock.calls[0]![0] as { label: string; functionName: string }[];
    expect(writes.map((w) => w.functionName)).toEqual(["release", "withdraw"]);
    run.mockRestore();
  });
});

describe("LP in Portfolio and pure helpers", () => {
  it("Portfolio lists the LP position with the LP token and a Manage link", () => {
    DS.seat = { ...vacant, holder: ME, price: 400_000000n, deposit: 30_000000n, bond: 100_000000n };
    wrap(<LpPositions />);
    const r = screen.getByTestId("portfolio-lp-row");
    expect(r.textContent).toMatch(/WETH \/ USDC LP/);
    expect(r.textContent).toMatch(/130\.00 cLP-WETH-USDC/);
    expect(within(r).getByRole("link", { name: "Manage" }).getAttribute("href")).toBe(`/lp?market=${MID}`);
  });

  it("zap-in quote, tax coverage, locked value and the LP token lookup", () => {
    const z = zapInQuote({ holder: OTHER, price: 400n, obligation: 1000n }, 500n, 50n, 1500);
    expect(z).toMatchObject({ toHolder: 400n, bond: 100n, deposit: 50n, total: 550n, lpBalance: 150n, yearly: 75n });
    expect(secondsCovered(75n, 500n, 1500)).toBe(365 * 86400);
    expect(lockedNow([{ quoteBal: 100n, assetBal: 2n * E18, assetDecimals: 18 }], 30n)).toEqual({ quote: 100n, asset: 2n * E18, value: 160n });
    expect(lockedNow([{ quoteBal: 100n, assetBal: 1n, assetDecimals: 18 }], undefined).value).toBeUndefined();
    expect(lpTokenOf({ seatLPTokens: { "0xAbC-0xDeF-1": "0x01" as `0x${string}` } }, { asset: "0xabc", quote: "0xdef", kind: 1 })).toBe("0x01");
  });
});
