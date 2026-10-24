// @vitest-environment jsdom
/**
 * A served network without a deployment (Sepolia before deployments/sepolia.json exists): every page that needs the
 * contracts shows one calm "not deployed yet" state, nothing asks the chain or the server index for it, and How it
 * works and the demo entry still render. Runs on the real chain registry, active chain and data hooks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const nav = vi.hoisted(() => ({ path: "/earn" }));
const client = vi.hoisted(() => ({ readContract: vi.fn(), multicall: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn(), call: vi.fn(), chain: { id: 11155111 } }));

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: undefined, isConnected: false, chainId: undefined }),
  usePublicClient: () => client,
  useBalance: () => ({ data: undefined }),
  useSignMessage: () => ({ mutateAsync: vi.fn() }),
  useWriteContract: () => ({ mutateAsync: vi.fn() }),
  useSwitchChain: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConnect: () => ({ mutate: vi.fn(), isPending: false }),
  useConnectors: () => [],
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useWatchAsset: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}));
vi.mock("@/lib/walletModal", () => ({ walletModal: () => undefined, openWalletPicker: vi.fn(), walletPickerStore: { subscribe: () => () => {}, get: () => false }, setWalletModal: vi.fn() }));

import { deployments } from "@confluere/sdk";
import { ActiveChainProvider, setChainChoice, useActiveChain } from "../src/lib/activeChain";
import { usePoolIndex, usePools, useVaults } from "../src/lib/data";
import { AppShell } from "../src/components/layout/AppShell";
import { deploymentLine } from "../src/components/more/HowItWorks";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ActiveChainProvider>{children}</ActiveChainProvider>
    </QueryClientProvider>
  );
}
const fetched: string[] = [];
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

beforeEach(() => {
  nav.path = "/earn";
  fetched.length = 0;
  for (const f of Object.values(client)) if (typeof f === "function") (f as any).mockReset();
  vi.stubGlobal("fetch", async (u: string) => (fetched.push(String(u)), { ok: false, status: 404, json: async () => ({}) }));
  act(() => setChainChoice(11155111));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => setChainChoice(998));
});

// these hold until deployments/sepolia.json exists; then Sepolia is an ordinary deployed network
describe.skipIf(!!deployments[11155111])("Sepolia before its deploy", () => {
  it("the active chain is Sepolia with no deployment", () => {
    const { result } = renderHook(() => useActiveChain(), { wrapper });
    expect(result.current.chainId).toBe(11155111);
    expect(result.current.deployment).toBeUndefined();
  });

  it("a page shows the calm not-deployed state instead of its screen, with the live networks and the demo", async () => {
    render(
      <AppShell>
        <p>the earn screen</p>
      </AppShell>,
      { wrapper },
    );
    await settle();
    const box = screen.getByTestId("not-deployed");
    expect(screen.queryByText("the earn screen")).toBeNull();
    expect(within(box).getByText("Not deployed on Sepolia yet")).toBeTruthy();
    expect(box.textContent).toMatch(/supports Sepolia Testnet, but its contracts are not deployed there yet/);
    expect(within(box).getByTestId("not-deployed-use-998").textContent).toBe("Use HyperEVM");
    expect(within(box).getByTestId("not-deployed-use-10143").textContent).toBe("Use Monad");
    expect(within(box).getByRole("link", { name: "Try the demo on Sepolia" }).getAttribute("href")).toBe("/developers/demo?chain=sepolia&demo=1");
    // no error line, no retry spam, and nothing asked about Sepolia (no index route, no contract read)
    expect(screen.queryByTestId("network-status")?.textContent ?? "").not.toMatch(/retrying|Can't reach/);
    expect(fetched.filter((u) => u.includes("11155111"))).toEqual([]);
    expect(client.readContract).not.toHaveBeenCalled();
    expect(client.multicall).not.toHaveBeenCalled();
    // the testnet strip and the network menu stay; the menu lists Sepolia as not deployed yet
    expect(screen.getByTestId("testnet-strip")).toBeTruthy();
    fireEvent.click(screen.getAllByTestId("network-menu")[0]!);
    expect(within(screen.getByTestId("network-11155111")).getByText("Not deployed yet")).toBeTruthy();
  });

  it("Use Monad switches the app to Monad testnet, where the page renders", async () => {
    const { rerender } = render(
      <AppShell>
        <p>the earn screen</p>
      </AppShell>,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("not-deployed-use-10143"));
    await settle();
    rerender(
      <AppShell>
        <p>the earn screen</p>
      </AppShell>,
    );
    expect(screen.queryByTestId("not-deployed")).toBeNull();
    expect(screen.getByText("the earn screen")).toBeTruthy();
  });

  it("How it works and the demo entry render without a deployment", async () => {
    for (const path of ["/how-it-works", "/developers/demo"]) {
      nav.path = path;
      render(
        <AppShell>
          <p>static page</p>
        </AppShell>,
        { wrapper },
      );
      expect(screen.getByText("static page")).toBeTruthy();
      expect(screen.queryByTestId("not-deployed")).toBeNull();
      cleanup();
    }
    expect(deploymentLine()).toBe("Testnet deployment on HyperEVM Testnet and Monad Testnet, same code at the same address. Sepolia Testnet is supported and not deployed yet. Test tokens have no value.");
  });

  it("the data hooks stay idle: no index request, no chain read, no error", async () => {
    const { result } = renderHook(() => ({ ix: usePoolIndex(), pools: usePools(), vaults: useVaults() }), { wrapper });
    await settle();
    expect(result.current.ix.ids).toEqual([]);
    expect(result.current.ix.isError).toBe(false);
    expect(result.current.pools.data ?? []).toEqual([]);
    expect(result.current.vaults.isError).toBe(false);
    expect(fetched).toEqual([]);
    expect(client.readContract).not.toHaveBeenCalled();
    expect(client.multicall).not.toHaveBeenCalled();
  });
});
