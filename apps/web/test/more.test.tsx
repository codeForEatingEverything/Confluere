// @vitest-environment jsdom
/** More pages (§8.6, §8.7): same plain words, denser. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Side, Status, marketId } from "@confluere/sdk";
import { DS, E18, NOW, OTHER, ZERO, order, pid, resetDS, row, wrap } from "./fixtures";

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", async () => {
  const { DS } = await import("./fixtures");
  return { usePathname: () => "/markets", useSearchParams: () => new URLSearchParams(DS.search ?? ""), useRouter: () => ({ push: () => {}, replace: () => {} }) };
});
vi.mock("wagmi", async () => (await import("./fixtures")).wagmiModule);
vi.mock("@/lib/tx", async () => (await import("./fixtures")).txModule);
vi.mock("@/lib/data", async () => (await import("./fixtures")).dataMock());
vi.mock("@/lib/position", async () => (await import("./fixtures")).positionMock());
vi.mock("@/lib/activeChain", async () => (await import("./fixtures")).activeChainMock());
vi.mock("@/lib/vaultMe", async () => (await import("./fixtures")).vaultMeMock());
vi.mock("@/lib/allowance", async () => (await import("./fixtures")).allowanceMock());
vi.mock("@/lib/refPrice", async () => (await import("./fixtures")).refPriceMock());
vi.mock("@/lib/seats", async () => (await import("./fixtures")).seatsMock());
vi.mock("@/lib/tokens", async (orig) => ({ ...(await (await import("./fixtures")).tokensMock(await orig())), useFaucetTokens: () => ({ data: [] }) }));

import { MarketsScreen } from "../src/components/markets/MarketsScreen";
import { CreateMarketCard } from "../src/components/more/CreateMarketCard";
import { DevelopersScreen } from "../src/components/more/DevelopersScreen";
import { HowItWorks } from "../src/components/more/HowItWorks";

beforeEach(() => {
  resetDS();
  DS.pools = [
    row(pid("a1")),
    row(pid("w1"), { status: Status.Window, expiry: NOW - 60, windowEnd: 1300n }),
    row(pid("c1"), { status: Status.Closed, expiry: NOW - 86400 }),
  ];
  DS.seat = { holder: ZERO, price: 0n, deposit: 0n, bond: 0n, lastTax: 0, priceLockedUntil: 0, lastQuotedBatch: 0, taxOwed: 0n, obligation: 1000_000000n, mine: 0n, unsplit: 0n, shareBps: 3500 };
});
afterEach(cleanup);

describe("markets pro view", () => {
  it("grouped by market, one row per maturity with fixed rate, buy-back, last traded and a status pill; closed hidden behind View past markets", () => {
    wrap(<MarketsScreen />);
    expect(screen.getByRole("heading", { name: "WETH / USDC" })).toBeTruthy();
    const rows = screen.getAllByTestId("markets-row");
    expect(rows).toHaveLength(2);
    // soonest first: the matured maturity still repaying, then the open one
    expect(rows[0]!.textContent).toMatch(/Repaying/);
    expect(rows[1]!.textContent).toMatch(/3,000\.00/);
    expect(rows[1]!.textContent).toMatch(/Open · /);
    expect(screen.getByText("Seat vacant")).toBeTruthy();
  });

  it("the filter row ends with Create market (opens /create); loop markets are listed and tagged; vaults follow", () => {
    DS.pools = [...DS.pools, row(pid("l1"), { asset: "0x00000000000000000000000000000000000000a3", quote: "0x00000000000000000000000000000000000000a4", bandBps: 150, strike: E18, lastClearingPrice: (E18 * 99n) / 100n })];
    DS.vaults = [{ address: "0x00000000000000000000000000000000000000c7", name: "v", symbol: "rvUSD-NATIVE-Low", quote: "0x00000000000000000000000000000000000000b2", epoch: 3n, targetExpiry: NOW + 3600, totalAssets: 4_840000n, totalSupply: 4_840000_000000n, kind: 0, strikeRule: 0, capBps: 2500, maxPriceBps: 9900, assets: ["0x00000000000000000000000000000000000000a1"], lastPokeBatch: 0, pendingDeposits: 0n, pendingRedeems: 0n }];
    wrap(<MarketsScreen />);
    const create = screen.getByTestId("create-market");
    expect(create.getAttribute("href")).toBe("/create");
    expect(create.textContent).toBe(" Create market");
    // Create market is the last control of the row that holds the past-markets button
    const filterRow = create.parentElement!;
    expect(within(filterRow).getByText("View past markets")).toBeTruthy();
    expect(filterRow.lastElementChild).toBe(create);
    expect(screen.getByRole("heading", { name: "kHYPE / HYPE" })).toBeTruthy();
    expect(screen.getByText("Loop market")).toBeTruthy();
    const v = screen.getByTestId("pro-vaults");
    expect(v.textContent).toMatch(/USDC Conservative vault/);
    expect(v.textContent).toMatch(/Lower buy-back price, 25% per round/);
  });

  it("the market page: key facts, one action per side to the standard forms, past rounds, open offers by side, market rules", () => {
    DS.search = `pool=${pid("a1")}`;
    DS.batches = [
      { index: 3, price: 2900_000000n, units: E18, nc: 0n, block: 10n },
      { index: 2, price: 2880_000000n, units: E18, nc: 0n, block: 9n },
    ];
    DS.book = { sells: [order(1n, Side.Sell, E18, 2950_000000n)], buys: [order(2n, Side.Buy, E18, 2850_000000n)], ncSells: [order(3n, Side.NcSell, 2n * E18, 0n)], ncBuys: [], bids: [] };
    wrap(<MarketsScreen />);
    const d = screen.getByTestId("pool-drawer");
    for (const k of ["Fixed rate", "Last traded", "Matures", "Status", "Outstanding", "Fee", "Borrower offers", "Lender offers", "Past rounds", "Borrowers (selling collateral)", "Lenders (lending)", "Market rules"]) expect(within(d).getAllByText(k).length).toBeGreaterThan(0);
    expect(within(d).getByRole("link", { name: "Borrow here" }).getAttribute("href")).toBe(`/borrow?pool=${pid("a1")}`);
    expect(within(d).getByRole("link", { name: "Lend here" }).getAttribute("href")).toBe(`/borrow?pool=${pid("a1")}&trade=lend`);
    expect(d.textContent).toMatch(/Market orders: 1 order, 2\.00 WETH/);
    expect(d.textContent).toMatch(/Market orders fill only within ±8% of the last price/);
    expect(d.textContent).not.toMatch(/P\*|\bK\b|batch|auction|strike|settle/);
  });

  it("during the repayment window the drawer offers for unclaimed units", () => {
    DS.search = `pool=${pid("w1")}`;
    DS.supplies = { [pid("w1")]: { c: E18, r: E18 / 4n } };
    wrap(<MarketsScreen />);
    const d = screen.getByTestId("pool-drawer");
    expect(within(d).getByText("Offer for unrepaid collateral")).toBeTruthy();
    expect(d.textContent).toMatch(/Not yet repaid: 0\.25 WETH/);
    expect(d.textContent).toContain("A borrower who repays in time always comes first.");
  });
});

describe("create market", () => {
  it("one card: collateral and loan asset, repayment, maturity, buy-back price with the grid check, fixed fees, auto-sell and price range; the button names the next step", () => {
    wrap(<CreateMarketCard />);
    for (const t of ["Collateral asset", "Loan asset", "Repayment", "Auto-sell defaulted collateral", "Market-order price range"]) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Select both assets" })).toBeTruthy();
    expect(screen.getByText(/One market per set of settings; the first creator sets the market-order price range and auto-sell\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/strike|band|cadence|batch/i);
  });
});

describe("developers and how it works", () => {
  it("developers: addresses, network settings and the flash-loan reference; no push list, no test tokens", () => {
    DS.pools = [row(pid("m1"), { expiry: NOW - 10 })];
    wrap(<DevelopersScreen />);
    for (const t of ["Addresses", "Network settings", "Flash loans", "How a loan executes", "Interface", "Examples", "Security checklist", "Fees, limits and errors"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.queryByTestId("due")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Needs a push|Test tokens/);
    expect(screen.getByRole("link", { name: "Open the demo" }).getAttribute("href")).toBe("/developers/demo");
    fireEvent.click(screen.getByRole("tab", { name: "Foundry test" }));
    expect(document.body.textContent).toMatch(/function test_flashLoan/);
  });
  it("how it works: borrow, lend, what never happens, known limits", () => {
    wrap(<HowItWorks />);
    for (const t of ["When you borrow", "When you lend", "What never happens", "Known limits"]) expect(screen.getByText(t)).toBeTruthy();
    expect(document.body.textContent).toMatch(/Post collateral, receive the loan now, buy the collateral back by the deadline, or keep the proceeds\./);
    expect(screen.getByText("Security and status")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/You deposit|cash/);
  });
});
