// @vitest-environment jsdom
/** Portfolio (§8.5): Needs you first, then loans, lending, vaults, orders and balances; every action in a modal or drawer. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Kind, Side, Status, repayAmount, rolloverTopUp } from "@confluere/sdk";
import { DS, E18, ME, NOW, VAULT, order, pid, resetDS, row, txMock, wrap } from "./fixtures";

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", async () => {
  const { DS } = await import("./fixtures");
  return { usePathname: () => "/portfolio", useSearchParams: () => new URLSearchParams(DS.search ?? ""), useRouter: () => ({ push: () => {}, replace: () => {} }) };
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

import { PortfolioScreen } from "../src/components/portfolio/PortfolioScreen";

const USDC = "0x00000000000000000000000000000000000000b2";
const WETH = "0x00000000000000000000000000000000000000a1";

beforeEach(() => {
  resetDS();
  DS.pools = [
    row(pid("a1")), // open, repay any time
    row(pid("b1"), { expiry: NOW + 7 * 86400, lastClearingPrice: 2950_000000n }), // later term of the same market
    row(pid("w1"), { kind: Kind.European, status: Status.Window, expiry: NOW - 60, windowEnd: 1300n }), // window open
    row(pid("c1"), { status: Status.Closed, expiry: NOW - 86400, quoteBal: 3000_000000n, assetBal: 0n }),
    row(pid("t1"), { cadence: 1, batchInterval: 1440, nextBatchAt: NOW + 60 }), // slow market, inside the cancel cut-off
  ];
  DS.positions = {
    [pid("a1")]: { c: 0n, r: E18, locked: 0n },
    [pid("w1")]: { c: 0n, r: 2n * E18, locked: 0n },
    [pid("c1")]: { c: E18, r: 0n, locked: 0n },
  };
  DS.supplies = { [pid("c1")]: { c: E18, r: 0n } };
  DS.pending = { [USDC]: 33_780000n };
  DS.orders = [{ ...order(7n, Side.NcSell, E18, 0n, ME, { deadline: 10 }), pid: pid("t1") }];
});
afterEach(cleanup);

describe("portfolio", () => {
  it("not connected: one card with Connect wallet and a way to start", () => {
    DS.connected = false;
    wrap(<PortfolioScreen />);
    expect(screen.getByText("Connect a wallet to see your positions.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.getByText(/No positions yet\?/)).toBeTruthy();
  });

  it("Needs you lists the open repayment window, the claim and the balances to withdraw, each with its button", () => {
    wrap(<PortfolioScreen />);
    const n = screen.getByTestId("needs-you");
    expect(n.textContent).toMatch(/Repay 6,000\.00 USDC by .+ to get 2\.00 WETH back\./);
    expect(within(n).getByTestId("collect-payout").textContent).toMatch(/1 matured position — collect your payout/);
    expect(n.textContent).toContain("Your lending matured: repaid loans pay out in USDC, unrepaid ones in collateral.");
    expect(n.textContent).not.toMatch(/\bclaim\b/i);
    expect(screen.getByTestId("portfolio-summary").textContent).toMatch(/To repay/);
    expect(n.textContent).toContain("33.78 USDC is ready to withdraw.");
    expect(within(n).getByRole("button", { name: "Repay" })).toBeTruthy();
    expect(within(n).getByRole("button", { name: "Collect" })).toBeTruthy();
    expect(within(n).getByRole("button", { name: "Withdraw all" })).toBeTruthy();
  });

  it("loans and lending rows speak plain words", () => {
    wrap(<PortfolioScreen />);
    const loans = screen.getByTestId("loans");
    expect(loans.textContent).toMatch(/1\.00 WETH/);
    expect(loans.textContent).toMatch(/USDC loan · buy-back/);
    expect(loans.textContent).toMatch(/Matured · repay/);
    expect(loans.textContent).toMatch(/Open/);
    const lending = screen.getByTestId("lending");
    expect(lending.textContent).toMatch(/backed by 1\.00 WETH/);
    expect(lending.textContent).toMatch(/Matured: collect 3,000\.00 USDC/);
    expect(within(lending).getByRole("button", { name: "Collect" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/R-Token|C-Token|strike|batch/);
  });

  it("Repay modal: amount to buy back, what you pay and get back, the deadline sentence", () => {
    wrap(<PortfolioScreen />);
    fireEvent.click(within(screen.getByTestId("needs-you")).getByRole("button", { name: "Repay" }));
    const m = screen.getByTestId("repay-modal");
    expect(within(m).getByText("Collateral to buy back")).toBeTruthy();
    expect(m.textContent).toMatch(/You pay\s*6,000\.00 USDC/);
    expect(m.textContent).toMatch(/You get back\s*2\.00 WETH/);
    expect(m.textContent).toMatch(/After that the position closes and lenders keep the WETH\./);
    expect(within(m).getByTestId("repay-button").textContent).toBe(`Repay 6,000.00 USDC`);
    void repayAmount;
  });

  it("Roll-over drawer: the later maturity, the top-up from the SDK, both outcomes (a failed roll-over changes nothing)", () => {
    wrap(<PortfolioScreen />);
    const loans = screen.getByTestId("loans");
    // only the open loan has a later term of its style to move to
    expect(within(loans).getAllByRole("button", { name: "Roll over" })).toHaveLength(1);
    fireEvent.click(within(loans).getByRole("button", { name: "Roll over" }));
    const d = screen.getByTestId("extend-drawer");
    expect(d.textContent).toMatch(/stays in the contract and is sold again into the .+ maturity at market price/);
    const minPrice = (2950_000000n * 9900n) / 10_000n;
    const top = d.textContent!.match(/You may need up to ([\d,.]+) USDC extra/);
    expect(top).toBeTruthy();
    const ttlFloor = 200; // ROLLOVER_TTL: a long rollover order has at least 200 rounds
    const expected = rolloverTopUp(E18, 3000_000000n, minPrice, ttlFloor, E18);
    expect(Number(top![1]!.replace(/,/g, ""))).toBeCloseTo(Number(expected) / 1e6, 1);
    expect(d.textContent).toMatch(/Nothing changes: repay .+ by the current deadline to get your WETH back/);
  });

  it("orders: plain description, and Cancel greyed in the last minute before a slow market's round", () => {
    wrap(<PortfolioScreen />);
    const o = screen.getByTestId("orders");
    expect(o.textContent).toMatch(/Borrow 1\.00 WETH at market price/);
    expect((within(o).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(o.textContent).toContain("Can't cancel in the last minute before a round.");
  });

  it("Withdraw all sends one withdrawal per token", async () => {
    DS.pending = { [USDC]: 33_780000n, [WETH]: E18 / 2n };
    const run = vi.spyOn(txMock, "run");
    wrap(<PortfolioScreen />);
    fireEvent.click(within(screen.getByTestId("needs-you")).getByRole("button", { name: "Withdraw all" }));
    await Promise.resolve();
    const writes = run.mock.calls[0]![0] as { functionName: string; args: unknown[] }[];
    expect(writes.map((w) => w.functionName)).toEqual(["withdraw", "withdraw"]);
    expect(writes.every((w) => w.args[1] === ME)).toBe(true);
    run.mockRestore();
  });

  it("several matured lending positions: one row and one Collect for all", () => {
    DS.pools = [...DS.pools, row(pid("c2"), { status: Status.Closed, expiry: NOW - 7200, quoteBal: 3000_000000n, assetBal: 0n })];
    DS.positions = { ...DS.positions, [pid("c2")]: { c: E18, r: 0n, locked: 0n } };
    DS.supplies = { ...DS.supplies, [pid("c2")]: { c: E18, r: 0n } };
    wrap(<PortfolioScreen />);
    const row1 = screen.getByTestId("collect-payout");
    expect(row1.textContent).toMatch(/2 matured positions — collect your payout/);
    expect(within(row1).getByRole("button", { name: "Collect" })).toBeTruthy();
  });

  it("a borrower sees Collect auction surplus only when a buyer paid extra", () => {
    DS.pools = [...DS.pools, row(pid("s1"), { status: Status.Closed, expiry: NOW - 7200, surplusBal: 10_000000n })];
    DS.positions = { ...DS.positions, [pid("s1")]: { c: 0n, r: E18, locked: 0n } };
    DS.supplies = { ...DS.supplies, [pid("s1")]: { c: 0n, r: E18 } };
    wrap(<PortfolioScreen />);
    expect(within(screen.getByTestId("needs-you")).getByRole("button", { name: "Collect auction surplus" })).toBeTruthy();
  });

  it("vault shares ready: a Collect row under Action required", () => {
    DS.vaults = [{ address: VAULT, name: "v", symbol: "rvUSD-NATIVE-Low", quote: USDC, epoch: 1n, targetExpiry: NOW, totalAssets: 1n, totalSupply: 1n, kind: 0, strikeRule: 0, capBps: 2500, maxPriceBps: 9900, assets: [WETH], lastPokeBatch: 0, pendingDeposits: 0n, pendingRedeems: 0n }];
    DS.vaultsMe = { [VAULT.toLowerCase()]: { pendingDeposit: 0n, claimableDeposit: 5n, pendingRedeem: 0n, claimableRedeem: 0n, shares: 0n, claimShares: 5n, claimAssets: 0n, assetCredits: [] } };
    wrap(<PortfolioScreen />);
    expect(screen.getByTestId("needs-you").textContent).toContain("Your vault shares or withdrawal are ready to collect.");
  });
});
