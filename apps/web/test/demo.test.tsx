// @vitest-environment jsdom
/**
 * IA v3.1 item 13: demo mode is the same app on sample data. The real data hooks and screens run against the sample
 * network (lib/demo); actions ask the wallet to sign a plain message and never call a contract or switch networks.
 * With the mode off, the live paths are untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const ME = "0x00000000000000000000000000000000000000e1" as const;
const w = vi.hoisted(() => ({
  connected: true,
  walletChain: 1 as number,
  sign: vi.fn(),
  write: vi.fn(),
  switchChain: vi.fn(),
  live: { readContract: vi.fn(), multicall: vi.fn(), getBlock: vi.fn(), simulateContract: vi.fn(), chain: { id: 998 } },
  replace: vi.fn(),
  path: "/",
  search: "",
}));

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({
  usePathname: () => w.path,
  useSearchParams: () => new URLSearchParams(w.search),
  useRouter: () => ({ push: vi.fn(), replace: w.replace, back: vi.fn() }),
}));
vi.mock("wagmi", () => ({
  useConnection: () => (w.connected ? { address: ME, isConnected: true, chainId: w.walletChain } : { address: undefined, isConnected: false, chainId: undefined }),
  usePublicClient: () => w.live,
  useBalance: () => ({ data: undefined }),
  useSignMessage: () => ({ mutateAsync: w.sign }),
  useWriteContract: () => ({ mutateAsync: w.write }),
  useSwitchChain: () => ({ mutateAsync: w.switchChain, isPending: false }),
  useConnect: () => ({ mutate: vi.fn(), isPending: false }),
  useConnectors: () => [],
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useWatchAsset: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
}));
vi.mock("@/lib/walletModal", () => ({ walletModal: () => undefined, openWalletPicker: vi.fn(), walletPickerStore: { subscribe: () => () => {}, get: () => false }, setWalletModal: vi.fn() }));

import { deployments } from "@confluere/sdk";
import { exitDemo, isDemo, setDemo } from "../src/lib/demo/mode";
import { resetDemoNetworks } from "../src/lib/demo/chain";
import { appFetch, demoClient } from "../src/lib/demo/client";
import { ActiveChainProvider, setChainChoice } from "../src/lib/activeChain";
import { deploymentOf, explorerTxUrl } from "../src/lib/chains";
import { useChainCtx } from "../src/lib/data";
import { useTx } from "../src/lib/tx";
import { withdrawWrite } from "../src/lib/actions";
import { TopBar, TestnetStrip } from "../src/components/layout/AppShell";
import { HomeScreen } from "../src/components/home/HomeScreen";
import { MarketsScreen } from "../src/components/markets/MarketsScreen";
import { EarnScreen } from "../src/components/earn/EarnScreen";
import { LpScreen } from "../src/components/lp/LpScreen";
import { PortfolioScreen } from "../src/components/portfolio/PortfolioScreen";

const USDC_998 = "0x2B3370eE501B4a559b57D449569354196457D8Ab" as const;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ActiveChainProvider>{children}</ActiveChainProvider>
    </QueryClientProvider>
  );
}
const show = (ui: ReactNode) => render(ui, { wrapper });
const liveCalls = () => w.live.readContract.mock.calls.length + w.live.multicall.mock.calls.length + w.live.getBlock.mock.calls.length + w.live.simulateContract.mock.calls.length;

beforeEach(() => {
  w.connected = true;
  w.walletChain = 1;
  w.sign.mockReset();
  w.write.mockReset();
  w.switchChain.mockReset();
  w.switchChain.mockResolvedValue(undefined);
  w.replace.mockReset();
  for (const f of Object.values(w.live)) if (typeof f === "function") (f as any).mockReset();
  w.path = "/";
  w.search = "";
  sessionStorage.clear();
  resetDemoNetworks();
  setChainChoice(998);
});
afterEach(() => {
  cleanup();
  exitDemo();
});

describe("demo mode: the same screens on sample data", () => {
  beforeEach(() => setDemo(true));

  it("the wordmark carries the DEMO badge and the strip offers Exit demo", () => {
    show(
      <>
        <TopBar />
        <TestnetStrip />
      </>,
    );
    expect(screen.getByTestId("demo-badge").textContent).toBe("DEMO");
    expect(screen.getByTestId("demo-strip").textContent).toMatch(/sample data/);
    expect(screen.queryByTestId("testnet-strip")).toBeNull();
  });

  it("the home card prices a loan from the sample markets, without reading a chain", async () => {
    show(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId("borrow-swap").textContent).toMatch(/Buy back at \d/), { timeout: 4000 });
    expect(screen.getByTestId("borrow-swap").textContent).toMatch(/USDC/);
    expect(liveCalls()).toBe(0);
  });

  it("Markets, Earn and LP list both repay styles, the vaults and the LP slots", async () => {
    show(<MarketsScreen />);
    await waitFor(() => expect(document.body.textContent).toMatch(/kHYPE/), { timeout: 4000 });
    // market names use the on-chain tokens: the wrapped coin keeps its own name
    expect(document.body.textContent).toMatch(/WHYPE \/ USDC/);
    expect(document.body.textContent).toMatch(/USDC \/ WHYPE/);
    expect(document.body.textContent).toMatch(/kHYPE \/ WHYPE/);
    cleanup();
    show(<EarnScreen />);
    await waitFor(() => expect(screen.getByTestId("vaults").textContent).toMatch(/USDC/), { timeout: 4000 });
    cleanup();
    show(<LpScreen />);
    await waitFor(() => expect(screen.getByTestId("lp-pools").textContent).toMatch(/HYPE/), { timeout: 4000 });
    expect(liveCalls()).toBe(0);
  });

  it("Portfolio gives the connected wallet loans, lending, a matured position and an order", async () => {
    show(<PortfolioScreen />);
    await waitFor(() => expect(screen.getByTestId("loans").textContent).toMatch(/HYPE/), { timeout: 8000 });
    expect(screen.getByTestId("lending").textContent).toMatch(/HYPE/);
    expect(screen.getByTestId("orders").textContent).toMatch(/HYPE|USDC/);
    // positions name the on-chain tokens: the wrapped coin is WHYPE, never merged into HYPE
    expect(document.body.textContent).toMatch(/WHYPE/);
    expect(document.body.textContent).toMatch(/matured position/i);
  }, 15_000);

  it("switching network changes the sample data and never asks the wallet", async () => {
    const { result } = renderHook(() => useChainCtx(), { wrapper });
    expect(result.current.deployment?.windowBlocks).toBe(7_200);
    act(() => setChainChoice(10143));
    await waitFor(() => expect(result.current.chainId).toBe(10143));
    expect(result.current.deployment?.windowBlocks).toBe(24_000);
    expect(w.switchChain).not.toHaveBeenCalled();
  });

  it("an action asks for a message signature, never a contract write or a network switch, and updates the sample state", async () => {
    w.sign.mockResolvedValue("0xsig");
    const client = demoClient(998);
    const before = (await client.readContract({ address: USDC_998, abi: [] as never, functionName: "balanceOf", args: [ME] } as never)) as bigint;
    const pending = (await client.readContract({ address: deploymentOf(998)!.confluere, abi: [] as never, functionName: "pending", args: [USDC_998, ME] } as never)) as bigint;
    expect(pending).toBeGreaterThan(0n);
    const { result } = renderHook(() => useTx(), { wrapper });
    let out: { ok: boolean } | undefined;
    await act(async () => {
      out = await result.current.run([withdrawWrite({ core: deploymentOf(998)!.confluere, account: ME }, USDC_998, "USDC")]);
    });
    expect(out).toEqual({ ok: true });
    expect(w.sign).toHaveBeenCalledTimes(1);
    expect(w.sign.mock.calls[0]![0].message).toMatch(/^Confluere demo: Withdraw USDC\n[\s\S]*sends no transaction/);
    expect(w.write).not.toHaveBeenCalled();
    expect(w.switchChain).not.toHaveBeenCalled();
    expect(result.current.steps[0]).toMatchObject({ status: "success" });
    expect(result.current.steps[0]!.hash).toMatch(/^0x[0-9a-f]{64}$/);
    const after = (await client.readContract({ address: USDC_998, abi: [] as never, functionName: "balanceOf", args: [ME] } as never)) as bigint;
    expect(after - before).toBe(pending);
    expect(explorerTxUrl(998, result.current.steps[0]!.hash!)).toBeUndefined();
  });

  it("a rejected signature is the neutral rejected state and changes nothing", async () => {
    w.sign.mockRejectedValue(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const client = demoClient(998);
    const read = () => client.readContract({ address: deploymentOf(998)!.confluere, abi: [] as never, functionName: "pending", args: [USDC_998, ME] } as never) as Promise<bigint>;
    const pending = await read();
    const { result } = renderHook(() => useTx(), { wrapper });
    let out: { ok: boolean } | undefined;
    await act(async () => {
      out = await result.current.run([withdrawWrite({ core: deploymentOf(998)!.confluere, account: ME }, USDC_998, "USDC")]);
    });
    expect(out).toEqual({ ok: false });
    expect(result.current.steps[0]).toMatchObject({ status: "rejected" });
    expect(await read()).toBe(pending);
    expect(w.write).not.toHaveBeenCalled();
  });

  it("a borrow escrows the collateral and fills at a later round into a buy-back right and a balance to withdraw", async () => {
    const { applyWrite, advance, demoNet } = await import("../src/lib/demo/chain");
    const net = demoNet(998)!;
    const d = deploymentOf(998)!;
    const client = demoClient(998);
    const idx = (await (await appFetch("/api/pools?chain=998")).json()) as { pools: { id: `0x${string}`; asset: string; kind: number; strike: string }[] };
    const pool = idx.pools.find((p) => p.asset === d.pools!.native && p.kind === 0)!;
    const view = (await client.readContract({ address: d.confluere, abi: [] as never, functionName: "pool", args: [pool.id] } as never)) as any;
    applyWrite(998, ME, { address: d.pools!.native, functionName: "approve", args: [d.confluere, 10n ** 30n] });
    applyWrite(998, ME, { address: d.confluere, functionName: "placeOrder", args: [pool.id, { side: 2, units: 10n ** 18n, limit: (view.lastClearingPrice * 90n) / 100n, budget: 0n, ttl: 4, hint: 0n, owner: "0x0000000000000000000000000000000000000000" }] });
    const orders = (await (await appFetch(`/api/orders?chain=998&owner=${ME}`)).json()) as { orders: { pool: string }[] };
    expect(orders.orders.some((o) => o.pool === pool.id)).toBe(true);
    advance(net, Math.floor(Date.now() / 1000) + 120);
    const r = (await client.readContract({ address: d.confluere, abi: [] as never, functionName: "balanceOf", args: [ME, BigInt(pool.id) | 1n] } as never)) as bigint;
    expect(r).toBeGreaterThanOrEqual(10n ** 18n);
  });
});

describe("leaving the demo", () => {
  it("Exit demo returns to the live app on the same page, without the marker", () => {
    setDemo(true);
    w.search = "chain=hyperevm&demo=1";
    show(<TestnetStrip />);
    fireEvent.click(screen.getByTestId("exit-demo"));
    expect(isDemo()).toBe(false);
    expect(w.replace).toHaveBeenCalledWith("/", { scroll: false });
    expect(deploymentOf(998)).toBe(deployments[998]);
    expect(screen.queryByTestId("demo-strip")).toBeNull();
  });
});

describe("live mode is unchanged", () => {
  it("reads go to the wallet library's client, routes to fetch, deployments to the SDK, and there is no badge", async () => {
    expect(isDemo()).toBe(false);
    const { result } = renderHook(() => useChainCtx(), { wrapper });
    expect(result.current.client).toBe(w.live);
    expect(deploymentOf(10143)).toBe(deployments[10143]);
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await appFetch("/api/pools?chain=998", { cache: "no-store" });
    expect(f).toHaveBeenCalledWith("/api/pools?chain=998", { cache: "no-store" });
    f.mockRestore();
    show(<TopBar />);
    expect(screen.queryByTestId("demo-badge")).toBeNull();
  });

  it("a live action still goes through the contract write, not a signature", async () => {
    w.walletChain = 998;
    w.live.simulateContract.mockResolvedValue({});
    w.write.mockResolvedValue(`0x${"ab".repeat(32)}`);
    (w.live as any).waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });
    const { result } = renderHook(() => useTx(), { wrapper });
    await act(async () => {
      await result.current.run([withdrawWrite({ core: deploymentOf(998)!.confluere, account: ME }, USDC_998, "USDC")]);
    });
    expect(w.write).toHaveBeenCalledTimes(1);
    expect(w.sign).not.toHaveBeenCalled();
  });
});
