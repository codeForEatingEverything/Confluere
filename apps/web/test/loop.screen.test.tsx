// @vitest-environment jsdom
/** Loop (IA v3.1 item 3): the same list + drawer as Borrow for staked-token markets; the drawer holds the loop calculator. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Kind } from "@confluere/sdk";
import { DS, E18, LST, NAT, NOW, pid, resetDS, row, wrap } from "./fixtures";

const nav = { pushed: [] as string[] };
vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", async () => {
  const { DS } = await import("./fixtures");
  return { usePathname: () => "/loop", useSearchParams: () => new URLSearchParams(DS.search ?? ""), useRouter: () => ({ push: (u: string) => nav.pushed.push(u), replace: (u: string) => nav.pushed.push(u), back: () => {} }) };
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

import { LoopScreen } from "../src/components/loop/LoopScreen";

const loopRow = (id: string, over: Record<string, unknown> = {}) => row(pid(id), { asset: LST, quote: NAT, bandBps: 150, strike: E18, lastClearingPrice: (E18 * 99n) / 100n, ...over });

beforeEach(() => {
  resetDS();
  nav.pushed = [];
  DS.pools = [row(pid("a1")), loopRow("l1"), loopRow("l2", { expiry: NOW + 7 * 86400, strike: (E18 * 101n) / 100n }), loopRow("e1", { kind: Kind.European })];
  DS.lstShares = E18; // 1 native = 1 staked
  DS.balances = { [LST]: 10n * E18 };
});
afterEach(cleanup);

describe("loop page", () => {
  it("lists every loop market, both repay styles (one to one with the pools), several to pick from", () => {
    wrap(<LoopScreen />);
    const rows = screen.getAllByTestId("loop-markets-row");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => /kHYPE \/ HYPE/.test(r.textContent!))).toBe(true);
    fireEvent.click(rows[1]!);
    expect([pid("l1"), pid("l2"), pid("e1")].map((p) => `/loop?pool=${p}`)).toContain(nav.pushed.at(-1));
  });

  it("the drawer shows the chart beside the loop calculator for the chosen market", () => {
    DS.search = `pool=${pid("l1")}`;
    wrap(<LoopScreen />);
    const d = screen.getByTestId("loop-drawer");
    expect(within(d).getByTestId("price-chart")).toBeTruthy();
    const c = within(d).getByTestId("loop-card");
    expect(c.textContent).toMatch(/Borrow HYPE against kHYPE, stake it into kHYPE again, repeat\./);
    fireEvent.change(within(c).getAllByRole("textbox")[0]!, { target: { value: "1" } });
    expect(within(d).getByTestId("loop-plan").textContent).toMatch(/Total exposure2\.97×/);
    expect(within(d).getByTestId("loop-plan").textContent).toMatch(/Liquidation priceNone/);
    expect(within(c).getByRole("button", { name: /Start round 1: borrow 0\.99 HYPE/ })).toBeTruthy();
  });

  it("a network without loop markets says so", () => {
    DS.pools = [row(pid("a1"))];
    wrap(<LoopScreen />);
    expect(screen.getByText("No loop markets on HyperEVM Testnet")).toBeTruthy();
  });
});
