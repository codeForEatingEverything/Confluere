// @vitest-environment jsdom
/** Earn (IA v3.1 item 4): vaults only, a plain explanation on top; the vault drawer explains how the vault works. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { DS, E18, NOW, VAULT, pid, resetDS, row, txMock, wrap } from "./fixtures";

const nav = { replaced: [] as string[] };
vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", async () => {
  const { DS } = await import("./fixtures");
  return {
    usePathname: () => "/earn",
    useSearchParams: () => new URLSearchParams(DS.search ?? ""),
    useRouter: () => ({ push: (u: string) => nav.replaced.push(u), replace: (u: string) => nav.replaced.push(u), back: () => {} }),
  };
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

import { EarnScreen } from "../src/components/earn/EarnScreen";

const USDC = "0x00000000000000000000000000000000000000b2";
const WETH = "0x00000000000000000000000000000000000000a1";
const vault = (address: string, symbol: string, strikeRule: number) => ({
  address,
  name: symbol,
  symbol,
  quote: USDC,
  epoch: 3n,
  targetExpiry: NOW + 3600,
  totalAssets: 4_840000n,
  totalSupply: 4_840000_000000n,
  kind: 0,
  strikeRule,
  capBps: 2500,
  maxPriceBps: 9900,
  assets: [WETH],
  lastPokeBatch: 0,
  pendingDeposits: 0n,
  pendingRedeems: 0n,
});

beforeEach(() => {
  resetDS();
  nav.replaced = [];
  DS.pools = [
    row(pid("a1"), { strike: 3000_000000n, lastClearingPrice: 2900_000000n }),
    row(pid("a2"), { strike: 3100_000000n, lastClearingPrice: 0n, graduated: false }),
    row(pid("b1"), { expiry: NOW + 3600, strike: 3000_000000n, lastClearingPrice: 2980_000000n }),
  ];
  DS.vaults = [vault(VAULT, "rvUSD-NATIVE-Low", 0), vault("0x00000000000000000000000000000000000000c9", "rvUSD-NATIVE-High", 1)];
  DS.balances = { [USDC]: 10_000_000000n };
});
afterEach(cleanup);

describe("earn", () => {
  it("vault rows: plain names, who they lend to, the current rate column, position hidden until connected", () => {
    DS.connected = false;
    wrap(<EarnScreen />);
    const v = screen.getByTestId("vaults");
    expect(within(v).getByText("USDC Conservative vault")).toBeTruthy();
    expect(within(v).getByText("USDC High-yield vault")).toBeTruthy();
    expect(within(v).getByText("Lends USDC to WETH borrowers, lower buy-back price")).toBeTruthy();
    expect(within(v).getAllByText("Connect to see").length).toBe(2);
    expect(v.textContent).toMatch(/Current rate/);
    expect(v.textContent).not.toMatch(/rvUSD|NAV|epoch|LST|stake/i);
  });

  it("vaults only: the plain explanation on top, no fixed-rate market list, a link to lend in one market", () => {
    wrap(<EarnScreen />);
    expect(screen.getByTestId("earn-intro").textContent).toBe(
      "You lend; borrowers post collateral to borrow. If they buy it back at maturity you get your money plus a fixed return; if they don't, you receive their collateral at the agreed price. A vault does this for you automatically, every term.",
    );
    expect(screen.queryByTestId("terms")).toBeNull();
    expect(screen.queryByText(/Fixed-rate markets/)).toBeNull();
    expect(screen.getByRole("link", { name: "Lend in one market" }).getAttribute("href")).toBe("/borrow");
  });

  it("a vault row opens its drawer as a history entry", () => {
    wrap(<EarnScreen />);
    fireEvent.click(screen.getAllByTestId("vaults-row")[0]!);
    expect(nav.replaced.at(-1)).toBe(`/earn?vault=${VAULT}`);
  });

  it("vault drawer: numbers and the action first, the three fixed sentences under How this vault works, claim rows", () => {
    DS.search = `vault=${VAULT}`;
    DS.vaultsMe = { [VAULT.toLowerCase()]: { pendingDeposit: 0n, claimableDeposit: 0n, pendingRedeem: 0n, claimableRedeem: 0n, shares: 1_000000_000000n, claimShares: 0n, claimAssets: 2_000000n, assetCredits: [{ token: WETH, amount: E18 / 50n }] } };
    wrap(<EarnScreen />);
    const d = screen.getByTestId("vault-drawer");
    const s = within(d).getByTestId("vault-sentences").textContent!;
    expect(s).toContain("This vault lends USDC to borrowers who sold WETH into the market. It never buys or holds WETH on purpose.");
    expect(s).toContain("If a borrower doesn't repay, their WETH is sold into the next maturity and the vault gets USDC back. You always withdraw in USDC only.");
    expect(s).toContain("Rule, fixed at deployment: lend at the lower buy-back price, at most 25% of idle funds each round, only into established markets that sell unrepaid collateral. Nobody can change it.");
    expect(within(d).getByText("Total deposits")).toBeTruthy();
    expect(within(d).getByText("1.00 USDC")).toBeTruthy(); // your position: 1e12 shares × 4.84 / 4.84e12
    expect(within(d).getByText(/Deposits are collected now and start lending at the next period/)).toBeTruthy();
    fireEvent.click(within(d).getByRole("radio", { name: "Withdraw" }));
    expect(within(d).getByRole("button", { name: "Withdraw 2.00 USDC" })).toBeTruthy();
    expect(within(d).getByText(/Also yours: 0\.02 WETH of collateral from borrowers who didn.t repay\./)).toBeTruthy();
    expect(within(d).getByText(/Withdrawals are requested now and paid at the end of this period/)).toBeTruthy();
    const how = within(d).getByTestId("vault-explainer").textContent!;
    for (const k of ["What it lends", "Where it lends", "Where the return comes from", "Worst case", "When money moves", "What a withdrawal pays", "Fees"]) expect(how).toContain(k);
    expect(how).toMatch(/Only in established markets/);
    expect(how).toMatch(/at most 25% of its idle USDC into each round/);
    expect(how).toMatch(/Not instantly/);
    expect(how).toMatch(/plus any WETH the vault received from borrowers who didn't repay/);
    expect(how).toMatch(/No management or performance fee\. The protocol keeps a share only of interest that borrowers actually repay/);
  });

});
