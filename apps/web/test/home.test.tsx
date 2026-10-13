// @vitest-environment jsdom
/** Home (IA v3.1 item 1): one card, Borrow | Repay. The router picks maturity and pool; Repay finds your loans. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Kind, Status } from "@confluere/sdk";
import { DS, E18, NOW, pid, resetDS, row, txMock, wrap } from "./fixtures";

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", async () => {
  const { DS } = await import("./fixtures");
  return { usePathname: () => "/", useSearchParams: () => new URLSearchParams(DS.search ?? ""), useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }) };
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

import { HomeScreen } from "../src/components/home/HomeScreen";

const WETH = "0x00000000000000000000000000000000000000a1";
const USDC = "0x00000000000000000000000000000000000000b2";

beforeEach(() => {
  resetDS();
  DS.pools = [
    // soonest maturity: two buy-back prices; the cheaper one to borrow (lower fixed rate) is a2
    row(pid("a1"), { strike: 3000_000000n, lastClearingPrice: 2800_000000n }),
    row(pid("a2"), { strike: 3100_000000n, lastClearingPrice: 2950_000000n }),
    row(pid("b1"), { expiry: NOW + 7 * 86400 }),
  ];
  DS.balances = { [WETH]: 10n * E18, [USDC]: 100_000_000000n };
});
afterEach(cleanup);

const pay = (v: string) => fireEvent.change(screen.getByTestId("pay-input"), { target: { value: v } });

describe("home: borrow", () => {
  it("a short intro with Read more, then the card; nothing about lending or positions", () => {
    wrap(<HomeScreen />);
    expect(screen.getByRole("link", { name: "Read more" }).getAttribute("href")).toBe("/how-it-works#different");
    expect(screen.getByTestId("home-demo").getAttribute("href")).toBe("/developers/demo");
    expect(screen.getByRole("tab", { name: "Borrow" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Repay" })).toBeTruthy();
    expect(screen.queryByTestId("lend-input")).toBeNull();
    expect(screen.getByTestId("swap-card").textContent).not.toMatch(/Claim|Collect|Lend /);
  });

  it("the router picks the soonest maturity and its cheapest pool; Maturity and Pool selectors let the person choose", () => {
    wrap(<HomeScreen />);
    expect(screen.getByTestId("maturity-select").textContent).toMatch(/Maturity/);
    expect(screen.getByTestId("route-line").textContent).toMatch(/Best pool for this date: .*buy-back price 3,100\.00 USDC/);
    expect(screen.getByTestId("buyback-right").textContent).toMatch(/Plus the right to buy back 1\.00 WETH for 3,100\.00 USDC/);
    // Pool: both pools of the maturity, the router's choice tagged Best; picking the other one updates the card
    fireEvent.click(screen.getByTestId("pool-select"));
    const pools = within(screen.getByTestId("pool-select-list")).getAllByTestId("pool-option");
    expect(pools).toHaveLength(2);
    expect(pools[0]!.textContent).toMatch(/buy back at 3,100\.00.*Best/);
    fireEvent.click(pools[1]!);
    expect(screen.getByTestId("route-line").textContent).toMatch(/Your pick: .*buy-back price 3,000\.00 USDC/);
    expect(screen.getByTestId("buyback-right").textContent).toMatch(/for 3,000\.00 USDC/);
    // Maturity: two open dates; the later one has a single pool
    fireEvent.click(screen.getByTestId("maturity-select"));
    const terms = within(screen.getByTestId("maturity-select-list")).getAllByTestId("term-chip");
    expect(terms).toHaveLength(2);
    expect(terms[0]!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(terms[1]!);
    expect(screen.getByTestId("route-line").textContent).toMatch(/Best pool for this date: .*buy-back price 3,000\.00 USDC/);
  });

  it("the details fold into one summary row; the full list opens with the chevron", () => {
    wrap(<HomeScreen />);
    const sum = screen.getByTestId("borrow-terms-summary");
    expect(sum.getAttribute("aria-expanded")).toBe("false");
    expect(sum.textContent).toMatch(/fixed · repay 3,100\.00 USDC per WETH by/);
    expect(screen.getByTestId("row-repay").closest("[hidden]")).toBeTruthy();
    fireEvent.click(sum);
    expect(sum.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("row-repay").closest("[hidden]")).toBeNull();
    // the worst case sits inside the folded details
    expect(screen.getByTestId("borrow-terms").textContent).toMatch(/If you don.t repay: you keep the USDC, lenders keep the WETH/);
  });

  it("You pay / You receive, and the button walks Enter an amount, Minimum, Not enough, Approve, Borrow", () => {
    DS.connected = false;
    const { unmount } = wrap(<HomeScreen />);
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    unmount();
    DS.connected = true;
    wrap(<HomeScreen />);
    const btn = () => screen.getByTestId("borrow-button");
    expect(btn().textContent).toBe("Enter an amount");
    pay("0.001");
    expect(btn().textContent).toMatch(/^Minimum is/);
    pay("20");
    expect(btn().textContent).toBe("Not enough WETH");
    DS.allowance = 0n;
    pay("1");
    expect(btn().textContent).toBe("Approve WETH");
    DS.allowance = undefined;
    pay("2");
    expect(btn().textContent).toBe("Borrow 5,900.00 USDC");
    expect((screen.getByTestId("receive-output") as HTMLInputElement).value).toBe("5,900.00");
    expect(screen.getByTestId("borrow-terms").textContent).toMatch(/Repay6,200\.00 USDC/);
  });

  it("Review shows what you pay and receive plus the buy-back right, and places the order", async () => {
    const run = vi.spyOn(txMock, "run");
    wrap(<HomeScreen />);
    pay("1");
    fireEvent.click(screen.getByTestId("borrow-button"));
    const m = screen.getByTestId("review-modal");
    expect(within(m).getByText("You pay")).toBeTruthy();
    expect(m.textContent).toMatch(/Plus the right to buy back 1\.00 WETH for 3,100\.00 USDC/);
    fireEvent.click(within(m).getByTestId("place-order"));
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });

  it("nothing open: the card keeps its shape and says why, never a fake zero", () => {
    DS.pools = [row(pid("z1"), { status: Status.Closed }), row(pid("z2"), { status: Status.Closed, expiry: NOW + 86400 })];
    wrap(<HomeScreen />);
    expect(screen.getByText("No open market on HyperEVM Testnet right now")).toBeTruthy();
    expect((screen.getByRole("button", { name: "No open market" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("while pools load: a skeleton", () => {
    DS.loading = true;
    DS.pools = [];
    wrap(<HomeScreen />);
    expect(screen.getByLabelText("Loading markets")).toBeTruthy();
  });
});

describe("home: repay", () => {
  beforeEach(() => {
    DS.pools = [...DS.pools, row(pid("w1"), { kind: Kind.European, status: Status.Window, expiry: NOW - 60, windowEnd: 1300n })];
    DS.positions = { [pid("a1")]: { c: 0n, r: E18, locked: 0n }, [pid("w1")]: { c: 0n, r: 2n * E18, locked: 0n } };
  });

  it("finds the loans you hold, the one due first selected; You pay follows You receive at the buy-back price", () => {
    wrap(<HomeScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Repay" }));
    fireEvent.click(screen.getByTestId("loan-select"));
    expect(screen.getAllByTestId("loan-chip")).toHaveLength(2);
    expect((screen.getByTestId("repay-receive") as HTMLInputElement).value).toBe("2");
    expect((screen.getByTestId("repay-pay") as HTMLInputElement).value).toBe("6000");
    fireEvent.click(screen.getAllByTestId("loan-chip")[1]!);
    expect((screen.getByTestId("repay-receive") as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByTestId("repay-pay"), { target: { value: "1500" } });
    expect((screen.getByTestId("repay-receive") as HTMLInputElement).value).toBe("0.5");
    expect(screen.getByTestId("repay-button").textContent).toBe("Repay 1,500.00 USDC");
  });

  it("button states: more than the loan, not enough, approve, repay; Repay runs the transaction", async () => {
    const run = vi.spyOn(txMock, "run");
    wrap(<HomeScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Repay" }));
    const btn = () => screen.getByTestId("repay-button");
    fireEvent.click(screen.getByTestId("loan-select"));
    fireEvent.click(screen.getAllByTestId("loan-chip")[1]!);
    fireEvent.change(screen.getByTestId("repay-receive"), { target: { value: "5" } });
    expect(btn().textContent).toBe("More than your loan");
    DS.balances = { [USDC]: 10_000000n };
    fireEvent.change(screen.getByTestId("repay-receive"), { target: { value: "1" } });
    expect(btn().textContent).toBe("Not enough USDC");
    DS.balances = { [USDC]: 100_000_000000n };
    DS.allowance = 0n;
    fireEvent.change(screen.getByTestId("repay-receive"), { target: { value: "0.9" } });
    expect(btn().textContent).toBe("Approve USDC");
    DS.allowance = undefined;
    fireEvent.change(screen.getByTestId("repay-receive"), { target: { value: "1" } });
    expect(btn().textContent).toBe("Repay 3,000.00 USDC");
    fireEvent.click(btn());
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });

  it("no loans: says so and points to Portfolio; not connected: Connect wallet", () => {
    DS.positions = {};
    const { unmount } = wrap(<HomeScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Repay" }));
    expect(screen.getByText("No loan to repay on this network")).toBeTruthy();
    unmount();
    DS.connected = false;
    wrap(<HomeScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Repay" }));
    expect(screen.getByText(/Connect a wallet to find your loans/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  });
});
