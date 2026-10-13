// @vitest-environment jsdom
/**
 * Demo mode actions on the real screens (IA v3.1 items 11 and 13): selling C before maturity works as a signed-message
 * mock trade; a vault that takes the wrapped coin pays with HYPE (the picker's second row is the wrapped token, marked);
 * Create market lists the coin next to the wrapped token and the network's other tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Hex } from "viem";

const ME = "0x00000000000000000000000000000000000000e2" as const;
const w = vi.hoisted(() => ({ sign: vi.fn(), write: vi.fn(), switchChain: vi.fn(), live: { readContract: vi.fn(), multicall: vi.fn(), getBlock: vi.fn(), simulateContract: vi.fn() } }));

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams(""), useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: ME, isConnected: true, chainId: 1 }),
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

import { Status, cTokenId, rTokenId } from "@confluere/sdk";
import { exitDemo, setDemo } from "../src/lib/demo/mode";
import { resetDemoNetworks } from "../src/lib/demo/chain";
import { appFetch, demoClient } from "../src/lib/demo/client";
import { ActiveChainProvider, setChainChoice } from "../src/lib/activeChain";
import { deploymentOf } from "../src/lib/chains";
import { tokenOf, usePool, useTokens } from "../src/lib/data";
import { sellOut, sellPrice } from "../src/lib/demo/sell";
import { TradeCard } from "../src/components/borrow/TradeCard";
import { VaultDrawer } from "../src/components/earn/VaultDrawer";
import { CreateMarketCard } from "../src/components/more/CreateMarketCard";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ActiveChainProvider>{children}</ActiveChainProvider>
    </QueryClientProvider>
  );
}
const show = (ui: ReactNode) => render(ui, { wrapper });

function Trade({ id }: { id: Hex }) {
  const p = usePool(id).data;
  const t = useTokens(p ? [p.asset, p.quote] : []).data;
  const A = p && tokenOf(t, p.asset);
  const Q = p && tokenOf(t, p.quote);
  return p && A && Q ? <TradeCard pool={p} A={A} Q={Q} initial="br" /> : null;
}

const core = () => deploymentOf(998)!.confluere;
const read = (functionName: string, args: unknown[], address = core()) => demoClient(998).readContract({ address, abi: [] as never, functionName, args } as never) as Promise<any>;

beforeEach(() => {
  for (const f of [w.sign, w.write, w.switchChain]) f.mockReset();
  sessionStorage.clear();
  resetDemoNetworks();
  setChainChoice(998);
  setDemo(true);
});
afterEach(() => {
  cleanup();
  exitDemo();
});

describe("demo: selling C before maturity", () => {
  it("signs a message, never writes a contract, lowers the C balance and pays the quote token", async () => {
    w.sign.mockResolvedValue("0xsig");
    const idx = (await (await appFetch("/api/pools?chain=998")).json()) as { pools: { id: Hex }[] };
    let id: Hex | undefined;
    let one = 0n;
    for (const p of idx.pools) {
      const v = await read("pool", [p.id]);
      if (v.status === Status.Open && v.lastClearingPrice > 0n && (await read("balanceOf", [ME, cTokenId(p.id)])) > 0n) {
        id = p.id;
        one = 10n ** BigInt(v.assetDecimals);
      }
    }
    expect(id).toBeDefined();
    const c0 = (await read("balanceOf", [ME, cTokenId(id!)])) as bigint;
    show(<Trade id={id!} />);
    const card = await screen.findByTestId("trade-card", undefined, { timeout: 4000 });
    fireEvent.click(within(card).getByTestId("trade-ft"));
    fireEvent.click(within(card).getByTestId("trade-sell"));
    expect(within(card).queryByTestId("sell-soon")).toBeNull();
    fireEvent.change(within(card).getByTestId("sell-input"), { target: { value: "1" } });
    await waitFor(() => expect((within(card).getByTestId("sell-button") as HTMLButtonElement).disabled).toBe(false), { timeout: 4000 });
    expect(within(card).getByTestId("sell-receive").textContent).toMatch(/about/);
    await act(async () => {
      fireEvent.click(within(card).getByTestId("sell-button"));
    });
    await waitFor(() => expect(w.sign).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(w.sign.mock.calls[0]![0].message).toMatch(/^Confluere demo: Sell C\nSell C \(lender token\) backed by 1(\.0+)? .* at the market price\./);
    await waitFor(async () => expect((await read("balanceOf", [ME, cTokenId(id!)])) as bigint).toBe(c0 - one), { timeout: 4000 });
    expect(w.write).not.toHaveBeenCalled();
    expect(w.switchChain).not.toHaveBeenCalled();
  });

  it("buying C signs a message, never writes a contract, and adds C to the wallet", async () => {
    w.sign.mockResolvedValue("0xsig");
    const idx = (await (await appFetch("/api/pools?chain=998")).json()) as { pools: { id: Hex }[] };
    let id: Hex | undefined;
    let one = 0n;
    for (const p of idx.pools) {
      const v = await read("pool", [p.id]);
      if (v.status === Status.Open && v.lastClearingPrice > 0n) {
        id = p.id;
        one = 10n ** BigInt(v.assetDecimals);
      }
    }
    expect(id).toBeDefined();
    const c0 = (await read("balanceOf", [ME, cTokenId(id!)])) as bigint;
    show(<Trade id={id!} />);
    const card = await screen.findByTestId("trade-card", undefined, { timeout: 4000 });
    fireEvent.click(within(card).getByTestId("trade-ft"));
    fireEvent.click(within(card).getByTestId("trade-buy"));
    fireEvent.change(within(card).getByTestId("buy-input"), { target: { value: "1" } });
    await waitFor(() => expect((within(card).getByTestId("buy-button") as HTMLButtonElement).disabled).toBe(false), { timeout: 4000 });
    await act(async () => {
      fireEvent.click(within(card).getByTestId("buy-button"));
    });
    await waitFor(() => expect(w.sign).toHaveBeenCalled(), { timeout: 4000 });
    expect(w.sign.mock.calls.at(-1)![0].message).toMatch(/Buy C \(lender token\)/);
    await waitFor(async () => expect((await read("balanceOf", [ME, cTokenId(id!)])) as bigint).toBe(c0 + one), { timeout: 4000 });
    expect(w.write).not.toHaveBeenCalled();
  });

  it("R is worth the reference price minus the C price, never below zero", () => {
    expect(sellPrice("c", 30_000000n, 38, 6)).toBe(30_000000n);
    expect(sellPrice("r", 30_000000n, 38, 6)).toBe(8_000000n);
    expect(sellPrice("r", 30_000000n, 20, 6)).toBe(0n);
    expect(sellPrice("r", 30_000000n, null, 6)).toBe(0n);
    expect(sellOut(10n ** 18n, 8_000000n, 18)).toBe(7_960000n);
  });
});

describe("demo: the wrapped coin pays as HYPE", () => {
  it("a vault that takes WHYPE starts on HYPE; the picker's second row is WHYPE with the wrapped mark", async () => {
    const v = deploymentOf(998)!.vaults!.pegged;
    expect((await read("asset", [], v)).toLowerCase()).toBe(deploymentOf(998)!.pools!.native.toLowerCase());
    show(<VaultDrawer address={v} onClose={() => {}} />);
    const btn = await waitFor(() => screen.getAllByTestId("token-button").find((b) => /HYPE/.test(b.textContent ?? ""))!, { timeout: 5000 });
    expect(btn.textContent).toMatch(/^HYPE/);
    fireEvent.click(btn);
    const sel = screen.getByTestId("token-select");
    expect(sel.textContent).toMatch(/HYPE/);
    expect(sel.textContent).toMatch(/WHYPE/);
    expect(within(sel).getAllByTestId("wrapped-badge")).toHaveLength(1);
  });

  it("Create market lists HYPE next to WHYPE and the network's tokens", async () => {
    show(<CreateMarketCard />);
    fireEvent.click(screen.getByRole("button", { name: /Choose the collateral asset/ }));
    const sel = screen.getByTestId("token-select");
    await waitFor(() => expect(sel.textContent).toMatch(/kHYPE/), { timeout: 4000 });
    const rowEls = [...sel.querySelectorAll<HTMLElement>("[data-token-row]")];
    const rows = rowEls.map((b) => b.textContent ?? "");
    expect(rows[0]).toMatch(/^HYPE/);
    expect(rows.some((r) => /^W?WHYPEWrapped HYPE/.test(r))).toBe(true);
    expect(rows.some((r) => /^USDC/.test(r))).toBe(true);
    fireEvent.click(rowEls[0]!);
    expect(screen.getByRole("button", { name: /Choose the collateral asset/ }).textContent).toMatch(/HYPE/);
  });
});
