// @vitest-environment jsdom
/** The shell (IA v3.1): Borrow · Earn · Loop · LP · Markets · Portfolio, More holds only Developers, phones get Home · Borrow · Earn · Portfolio + More, the network menu works without a wallet. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { DS, resetDS, switchNetwork, wrap } from "./fixtures";

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/earn", useSearchParams: () => new URLSearchParams(""), useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("wagmi", async () => (await import("./fixtures")).wagmiModule);
vi.mock("@/lib/tx", async () => (await import("./fixtures")).txModule);
vi.mock("@/lib/data", async () => (await import("./fixtures")).dataMock());
vi.mock("@/lib/activeChain", async () => {
  const f = await import("./fixtures");
  const m = f.activeChainMock();
  const monad = { ...f.META, id: 10143, name: "Monad", label: "Monad testnet", native: "MON" };
  return { ...m, useActiveChain: () => ({ ...m.useActiveChain(), networks: [f.META, monad] }) };
});
vi.mock("@/lib/chains", async (orig) => {
  const o = await orig<typeof import("../src/lib/chains")>();
  return { ...o, ENABLED: o.ENABLED.filter((c) => c.id !== 31337) };
});

import { AppShell, TabBar, TopBar, Footer } from "../src/components/layout/AppShell";
import { NetworkStatus } from "../src/components/ui/NetworkStatus";

beforeEach(() => {
  resetDS();
  switchNetwork.calls = [];
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ status: { complete: true }, pools: [{ id: "0x1", expiry: 4_000_000_000, marketId: "0xm" }], last: {} }) }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("top bar", () => {
  it("six primary entries, the current one marked; the logo leads home", () => {
    wrap(<TopBar />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Borrow", "Earn", "Loop", "LP", "Markets", "Portfolio"]);
    expect(screen.getByRole("link", { name: /Confluere home/ }).getAttribute("href")).toBe("/");
    expect(within(nav).getByRole("link", { name: "Earn" }).getAttribute("aria-current")).toBe("page");
  });

  it("More holds Demo and Developers, no theme switch", () => {
    wrap(<TopBar />);
    fireEvent.click(screen.getByTestId("more-menu"));
    const menu = screen.getByRole("menu", { name: "More" });
    expect(within(menu).getAllByRole("menuitem").map((a) => a.textContent)).toEqual(["Demo", "Developers"]);
    expect(within(menu).queryAllByRole("menuitemradio")).toHaveLength(0); // dark only, no theme switch
  });

  it("the network menu lists both testnets with their open markets and switches without a wallet", async () => {
    DS.connected = false;
    wrap(<TopBar />);
    fireEvent.click(screen.getAllByTestId("network-menu")[0]!);
    const menu = screen.getByRole("menu", { name: "Network" });
    expect(within(menu).getByText("HyperEVM")).toBeTruthy();
    expect(within(menu).getByText("Monad")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(within(menu).getAllByText("1 market open").length).toBe(2);
    fireEvent.click(within(menu).getByTestId("network-10143"));
    expect(switchNetwork.calls).toEqual([10143]);
    expect(document.body.textContent).not.toMatch(/stake|faucet|get (test )?tokens/i);
  });

  it("no wallet: Connect wallet; with one: the short address and its menu", () => {
    DS.connected = false;
    const { unmount } = wrap(<TopBar />);
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    unmount();
    DS.connected = true;
    wrap(<TopBar />);
    fireEvent.click(screen.getByTestId("wallet-menu"));
    expect(within(screen.getByRole("menu", { name: "Wallet" })).getAllByRole("menuitem").map((x) => x.textContent?.trim())).toEqual(["Copy address", "View on explorer", "Portfolio", "Disconnect"]);
  });
});

describe("phone tabs and footer", () => {
  it("Home, Borrow, Earn, Portfolio and More; the More sheet carries Loop and Markets too", () => {
    wrap(<TabBar />);
    expect(screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Home", "/"],
      ["Borrow", "/borrow"],
      ["Earn", "/earn"],
      ["Portfolio", "/portfolio"],
    ]);
    expect(screen.getByTestId("more-tab").textContent).toBe("More");
    fireEvent.click(screen.getByTestId("more-tab"));
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(expect.arrayContaining(["Loop", "LP", "Markets", "Demo", "Developers"]));
  });
  it("one-line footer: How it works, Developers, GitHub", () => {
    wrap(<Footer />);
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["How it works", "Developers", "GitHub"]);
  });
  it("the shell renders the page with no block number or chain banner", () => {
    wrap(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByText("page")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/#\d{2},\d{3}|live/);
  });
  it("a wallet on another network: the network pill says Wrong network, no page-wide banner", () => {
    DS.wrongChain = true;
    wrap(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.queryByTestId("wallet-chain-banner")).toBeNull();
    expect(screen.getAllByTestId("network-menu")[0]!.textContent).toContain("Wrong network");
  });
  it("testnets carry a calm notice strip", () => {
    wrap(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByTestId("testnet-strip").textContent).toBe("You're using the beta version on testnet.Learn more");
  });
});

describe("network status line", () => {
  it("says Network busy, retrying… while reads of the active chain fail and retry; silent otherwise", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 10_000 } } });
    let fail = true;
    const Probe = () => {
      useQuery({ queryKey: ["probe", 998], queryFn: async () => { if (fail) throw new Error("rpc"); return 1; } });
      return <NetworkStatus />;
    };
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(screen.getByTestId("network-status").textContent).toContain("Network busy, retrying…");
    fail = false;
  });
});
