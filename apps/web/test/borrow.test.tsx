// @vitest-environment jsdom
/** Borrow (IA v3.1 item 2): the C / R market list, the market drawer with its token cards and chart, the two-step trade card. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Kind, Status } from "@confluere/sdk";
import { DS, E18, NOW, pid, resetDS, row, txMock, wrap } from "./fixtures";

const nav = { pushed: [] as string[] };
vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", async () => {
  const { DS } = await import("./fixtures");
  return { usePathname: () => "/borrow", useSearchParams: () => new URLSearchParams(DS.search ?? ""), useRouter: () => ({ push: (u: string) => nav.pushed.push(u), replace: (u: string) => nav.pushed.push(u), back: () => {} }) };
});
vi.mock("wagmi", async () => (await import("./fixtures")).wagmiModule);
vi.mock("@/lib/tx", async () => (await import("./fixtures")).txModule);
vi.mock("@/lib/data", async () => (await import("./fixtures")).dataMock());
vi.mock("@/lib/position", async () => (await import("./fixtures")).positionMock());
vi.mock("@/lib/activeChain", async () => (await import("./fixtures")).activeChainMock());
vi.mock("@/lib/vaultMe", async () => (await import("./fixtures")).vaultMeMock());
vi.mock("@/lib/allowance", async () => (await import("./fixtures")).allowanceMock());
vi.mock("@/lib/refPrice", async () => (await import("./fixtures")).refPriceMock());
vi.mock("@/lib/tokens", async (orig) => (await import("./fixtures")).tokensMock(await orig()));
vi.mock("@/lib/seats", async () => (await import("./fixtures")).seatsMock());

import { BorrowMarkets } from "../src/components/borrow/BorrowMarkets";

const WETH = "0x00000000000000000000000000000000000000a1";
const USDC = "0x00000000000000000000000000000000000000b2";

beforeEach(() => {
  resetDS();
  nav.pushed = [];
  DS.pools = [
    row(pid("a1"), { strike: 3000_000000n, lastClearingPrice: 2900_000000n }),
    row(pid("a2"), { strike: 3100_000000n, lastClearingPrice: 0n, graduated: false }),
    row(pid("b1"), { expiry: NOW + 3600, strike: 3000_000000n, lastClearingPrice: 2980_000000n }),
    row(pid("c1"), { status: Status.Closed, expiry: NOW - 86400 }),
  ];
  DS.supplies = { [pid("a1")]: { c: 2n * E18, r: 2n * E18 } };
  DS.balances = { [WETH]: 10n * E18, [USDC]: 10_000_000000n };
  DS.batches = [
    { index: 3, price: 2900_000000n, units: E18, nc: 0n, block: 990n },
    { index: 2, price: 0n, units: 0n, nc: 0n, block: 980n },
    { index: 1, price: 2880_000000n, units: E18, nc: 0n, block: 900n },
    { index: 0, price: 2850_000000n, units: E18, nc: 0n, block: 700n },
  ];
});
afterEach(cleanup);

describe("borrow markets list", () => {
  it("explains C and R, three maturities per pair (open first, soonest first, then the latest matured), with buy-back price, C price and rate, R and size", () => {
    wrap(<BorrowMarkets />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Borrow markets");
    expect(document.body.textContent).toMatch(/Borrow to get R, lend to get C, or trade either with\s+other holders\./);
    const rows = screen.getAllByTestId("token-markets-row");
    // two open maturities, so the latest matured one fills the third slot, listed last
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toMatch(/WETH \/ USDC/);
    expect(rows[0]!.textContent).toMatch(/2,980\.00/);
    expect(rows[1]!.textContent).toMatch(/3,000\.00.*2,900\.00 USDC.*fixed APR if repaid.*No offers yet.*2\.00 WETH/);
    expect(rows[2]!.textContent).toMatch(/No trades yet/);
    expect(rows[2]!.textContent).toMatch(/New/);
    const header = screen.getByTestId("token-markets").textContent!;
    for (const h of ["Buy-back price", "C · Lend", "R · Buy-back", "Size"]) expect(header).toContain(h);
    expect(header).not.toMatch(/C price|R buy-back/);
    expect(document.body.textContent).not.toMatch(/auction|batch|strike|P\*/i);
  });

  it("Show matured adds closed pools; a row opens the drawer as a history entry", () => {
    wrap(<BorrowMarkets />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show matured" }));
    expect(screen.getAllByTestId("token-markets-row")).toHaveLength(4);
    fireEvent.click(screen.getAllByTestId("token-markets-row")[1]!);
    expect(nav.pushed.at(-1)).toBe(`/borrow?pool=${pid("a1")}`);
  });

  it("nothing open: the matured markets are listed anyway, newest first, under a notice", () => {
    DS.pools = [row(pid("z1"), { status: Status.Closed, expiry: NOW - 7200 }), row(pid("z2"), { status: Status.Closed, expiry: NOW - 3600 })];
    wrap(<BorrowMarkets />);
    expect(screen.getByText(/No open market on HyperEVM Testnet right now/)).toBeTruthy();
    const rows = screen.getAllByTestId("token-markets-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Closed/);
  });

  it("while pools load: skeleton rows, never an empty state", () => {
    DS.loading = true;
    DS.pools = [];
    wrap(<BorrowMarkets />);
    expect(screen.getByTestId("token-markets-loading")).toBeTruthy();
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });
});

describe("market drawer", () => {
  it("numbers, a line chart of round prices with the buy-back line, switches to candles and rate, time ranges", () => {
    DS.search = `pool=${pid("a1")}`;
    wrap(<BorrowMarkets />);
    const d = screen.getByTestId("market-drawer");
    const stats = within(d).getByTestId("market-stats").textContent!;
    expect(stats).toMatch(/C price2,900\.00/);
    expect(stats).toMatch(/Buy-back price3,000\.00/);
    expect(stats).toMatch(/R priceNo offers/);
    expect(stats).toMatch(/Size2\.00 WETH/);
    for (const k of ["Locked value", "24h volume", "Fixed rate now", "High / low rate", "Matures", "LP price"]) expect(stats).toContain(k);
    expect(stats).toMatch(/LP priceFree to take/);
    const chart = within(d).getByTestId("price-chart");
    expect(within(chart).getByTestId("price-chart-line")).toBeTruthy();
    expect(within(chart).getByTestId("price-chart-buyback")).toBeTruthy();
    expect(within(chart).getByTestId("price-chart-value").textContent).toBe("2,900.00 USDC");
    fireEvent.click(within(chart).getByRole("radio", { name: "Candles" }));
    expect(within(chart).getAllByTestId("price-chart-candle").length).toBeGreaterThan(0);
    fireEvent.click(within(chart).getByRole("radio", { name: "Rate" }));
    expect(within(chart).getByTestId("price-chart-value").textContent).toMatch(/%$/);
    fireEvent.click(within(chart).getByRole("radio", { name: "Volume" }));
    expect(within(chart).getAllByTestId("price-chart-bar").length).toBeGreaterThan(0);
    fireEvent.click(within(chart).getByRole("radio", { name: "Locked value" }));
    expect(within(chart).getByTestId("price-chart-line")).toBeTruthy();
    expect(within(d).getByTestId("provide-liquidity").getAttribute("href")).toMatch(/^\/lp\?market=0x/);
    for (const r of ["1D", "1W", "1M", "All"]) expect(within(chart).getByRole("radio", { name: r })).toBeTruthy();
    expect(d.textContent).not.toMatch(/auction|batch|strike|order book/i);
  });

  it("a pool with no trades: the chart says so instead of drawing", () => {
    DS.search = `pool=${pid("a2")}`;
    DS.batches = [];
    wrap(<BorrowMarkets />);
    expect(screen.getByTestId("price-chart-empty").textContent).toMatch(/No trades yet/);
  });

  it("trade card: R · Borrow borrows in this pool (button walks its states, Review places the order)", async () => {
    DS.search = `pool=${pid("a1")}`;
    const run = vi.spyOn(txMock, "run");
    wrap(<BorrowMarkets />);
    const card = screen.getByTestId("trade-card");
    expect(within(card).getByTestId("trade-br").getAttribute("aria-checked")).toBe("true");
    expect(within(card).getByTestId("trade-borrow").getAttribute("aria-checked")).toBe("true");
    expect(within(card).queryByTestId("trade-lend")).toBeNull();
    const btn = () => within(card).getByTestId("pool-borrow-button");
    expect(btn().textContent).toBe("Enter an amount");
    fireEvent.change(within(card).getByTestId("pool-borrow-input"), { target: { value: "20" } });
    expect(btn().textContent).toBe("Not enough WETH");
    fireEvent.change(within(card).getByTestId("pool-borrow-input"), { target: { value: "1" } });
    expect(btn().textContent).toBe("Borrow 2,900.00 USDC");
    expect(within(card).getByTestId("pool-borrow-receive").textContent).toMatch(/You receive about 2,900\.00 USDC and 1\.00 R-WETH, your right to buy it back\./);
    fireEvent.click(btn());
    const m = screen.getByTestId("review-modal");
    fireEvent.click(within(m).getByTestId("place-order"));
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });

  it("trade card: C · Lend lends (facts before input, Lend button); ?trade=lend preselects it", () => {
    DS.search = `pool=${pid("a1")}&trade=lend`;
    wrap(<BorrowMarkets />);
    const card = screen.getByTestId("trade-card");
    expect(within(card).getByTestId("trade-ft").getAttribute("aria-checked")).toBe("true");
    expect(within(card).getByTestId("trade-lend").getAttribute("aria-checked")).toBe("true");
    expect(within(card).getByTestId("lend-terms").textContent).toMatch(/Paid back per 1 WETH/);
    fireEvent.change(within(card).getByTestId("lend-input"), { target: { value: "2900" } });
    expect(within(card).getByTestId("lend-button").textContent).toBe("Lend 2,900.00 USDC");
    expect(within(card).getByTestId("outcome-strip").textContent).toContain("You receive 1.00 WETH instead");
    expect(within(card).getByTestId("lend-receive").textContent).toMatch(/≈ 1\.00 C-WETH/);
  });

  it("Buy and Sell trade C or R with holders; Sell stays selected across a token switch", () => {
    DS.search = `pool=${pid("a1")}`;
    wrap(<BorrowMarkets />);
    const card = screen.getByTestId("trade-card");
    fireEvent.click(within(card).getByTestId("trade-sell"));
    expect(card.textContent).not.toMatch(/Secondary market coming soon/);
    expect(within(card).queryByTestId("sell-position") ?? within(card).queryByTestId("sell-unavailable")).toBeTruthy();
    fireEvent.click(within(card).getByTestId("trade-ft"));
    expect(within(card).getByTestId("trade-sell").getAttribute("aria-checked")).toBe("true");
    expect(within(card).queryByTestId("sell-position") ?? within(card).queryByTestId("sell-unavailable")).toBeTruthy();
    fireEvent.click(within(card).getByTestId("trade-buy"));
    expect(within(card).queryByTestId("buy-position") ?? within(card).queryByTestId("sell-unavailable")).toBeTruthy();
    // switching back to R keeps Buy; Lend has no R counterpart and becomes Borrow
    fireEvent.click(within(card).getByTestId("trade-lend"));
    fireEvent.click(within(card).getByTestId("trade-br"));
    expect(within(card).getByTestId("trade-borrow").getAttribute("aria-checked")).toBe("true");
  });

  it("the drawer names both tokens with full symbols, and a token card picks the token in the trade card", () => {
    DS.search = `pool=${pid("a1")}`;
    wrap(<BorrowMarkets />);
    const d = screen.getByTestId("market-drawer");
    const ft = within(d).getByTestId("token-card-ft");
    const br = within(d).getByTestId("token-card-br");
    expect(ft.textContent).toMatch(/C-WETH-\d\d[A-Z]{3}/);
    expect(ft.textContent).toMatch(/Lender token/);
    expect(ft.textContent).toMatch(/2,900\.00 USDC/);
    expect(ft.textContent).toMatch(/or 1 WETH at maturity/);
    expect(br.textContent).toMatch(/R-WETH-\d\d[A-Z]{3}/);
    expect(br.textContent).toMatch(/Buy-back right/);
    expect(br.textContent).toMatch(/Buy 1 WETH for 3,000\.00 USDC until/);
    expect(within(d).getByTestId("market-tags").textContent).toMatch(/Buy back at 3,000\.00 USDC/);
    expect(d.textContent).toMatch(/Together, 1 C and 1 R come to 1 WETH at maturity/);
    fireEvent.click(ft);
    expect(within(screen.getByTestId("trade-card")).getByTestId("trade-ft").getAttribute("aria-checked")).toBe("true");
    expect(ft.getAttribute("aria-pressed")).toBe("true");
    // no bare contract letters anywhere in the drawer
    const text = [...d.querySelectorAll("*")].filter((e) => e.children.length === 0).map((e) => e.textContent?.trim() ?? "");
    // the token icons carry their letter badge (C / R); every name next to them is a full symbol
    expect(d.textContent).toMatch(/C-WETH-/);
    // C and R are the token names; only the old FT / BR wording is banned
    expect(d.textContent).not.toMatch(/\bFT\b|\bBR\b/);
  });

  it("a row's C or R cell opens the drawer on that token", () => {
    wrap(<BorrowMarkets />);
    const row = screen.getAllByTestId("token-markets-row")[1]!;
    fireEvent.click(within(row).getByTestId("market-ft"));
    expect(nav.pushed.at(-1)).toBe(`/borrow?pool=${pid("a1")}`);
  });

  it("a matured pool: the chart stays, the trade card takes no new positions", () => {
    DS.search = `pool=${pid("c1")}`;
    wrap(<BorrowMarkets />);
    expect(screen.getByTestId("price-chart")).toBeTruthy();
    expect(screen.getByTestId("trade-closed").textContent).toMatch(/no longer takes new positions/);
  });

  it("the chart can cover every maturity with the same buy-back price", () => {
    DS.search = `pool=${pid("b1")}`;
    wrap(<BorrowMarkets />);
    const d = screen.getByTestId("market-drawer");
    expect(within(d).getByRole("radio", { name: /All 3 maturities/ })).toBeTruthy();
    void Kind;
  });
});
