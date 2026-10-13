// @vitest-environment jsdom
/**
 * IA v3.1 item 13: every pairing, buy-back price, repay style and maturity of the demo's sample set shows up on every
 * page that lists it, and nothing else does. The expected numbers are counted from the sample index (the /api/pools
 * answer in demo mode) and the pools' on-chain status; each page is rendered on the same data and its rows counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const ME = "0x00000000000000000000000000000000000000e1" as const;
const nav = vi.hoisted(() => ({ qs: "" }));
const w = vi.hoisted(() => ({
  live: { readContract: vi.fn(), multicall: vi.fn(), getBlock: vi.fn(), simulateContract: vi.fn(), chain: { id: 998 } },
}));

vi.mock("next/link", () => ({ default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(nav.qs),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("wagmi", () => ({
  useConnection: () => ({ address: ME, isConnected: true, chainId: 1 }),
  usePublicClient: () => w.live,
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

import { Kind, Status, marketId } from "@confluere/sdk";
import { exitDemo, setDemo } from "../src/lib/demo/mode";
import { indexPools, readCall, resetDemoNetworks } from "../src/lib/demo/chain";
import { ActiveChainProvider, setChainChoice } from "../src/lib/activeChain";
import { deploymentOf, launchTokensOf } from "../src/lib/chains";
import { loopMarkets } from "../src/lib/loop";
import { isPegged } from "../src/lib/markets";
import { pairsOf, selectorTokens } from "../src/lib/product";
import { isNative } from "../src/lib/native";
import { tokenLogo } from "../src/lib/logos";
import { usePools, useVaults } from "../src/lib/data";
import { demoClient } from "../src/lib/demo/client";
import { BorrowMarkets } from "../src/components/borrow/BorrowMarkets";
import { LoopScreen } from "../src/components/loop/LoopScreen";
import { MarketsScreen } from "../src/components/markets/MarketsScreen";
import { LpScreen } from "../src/components/lp/LpScreen";
import { EarnScreen } from "../src/components/earn/EarnScreen";
import { VaultDrawer } from "../src/components/earn/VaultDrawer";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <ActiveChainProvider>{children}</ActiveChainProvider>
    </QueryClientProvider>
  );
}
const show = (ui: ReactNode) => render(ui, { wrapper });
const rows = (id: string) => screen.queryAllByTestId(`${id}-row`).length;

type Ix = { id: `0x${string}`; asset: `0x${string}`; quote: `0x${string}`; expiry: number; strike: string; kind: number; bandBps: number; feeBps: number };

/** The sample set as a page sees it: every pool with its status, split the way the pages split it. */
function dataset(chainId: number) {
  const d = deploymentOf(chainId)!;
  const now = Math.floor(Date.now() / 1000);
  const pools = (indexPools(chainId).pools as Ix[]).map((p) => {
    const v = readCall(chainId, { address: d.confluere, functionName: "pool", args: [p.id] }) as { status: number; lastClearingPrice: bigint };
    return { ...p, status: v.status, lastClearingPrice: v.lastClearingPrice };
  });
  const open = pools.filter((p) => p.status === Status.Open && p.expiry > now);
  const notClosed = pools.filter((p) => p.status !== Status.Closed);
  const markets = new Set(pools.map((p) => marketId(p.asset, p.quote, p.kind)));
  const openMarkets = new Set(open.map((p) => marketId(p.asset, p.quote, p.kind)));
  const loopOpen = loopMarkets(open as never as { kind: Kind; asset: string; bandBps: number }[], chainId);
  return { pools, open, notClosed, markets, openMarkets, loopOpen };
}

/** Rows a list shows for a set of on-chain rows: each once, plus one native twin for each row touching the wrapped coin. */
const touches = (chainId: number, ...a: string[]) => a.some((x) => x.toLowerCase() === launchTokensOf(chainId).native!.toLowerCase());
const listed = (chainId: number, xs: { asset: string; quote: string }[]) => xs.length + xs.filter((p) => touches(chainId, p.asset, p.quote)).length;

const sym = (chainId: number, a: string) => {
  const t = launchTokensOf(chainId);
  const x = a.toLowerCase();
  if (x === t.native?.toLowerCase()) return chainId === 998 ? "WHYPE" : "WMON";
  if (x === t.usdc?.toLowerCase()) return "USDC";
  if (x === t.lst?.toLowerCase()) return chainId === 998 ? "kHYPE" : "shMON";
  return "?";
};

beforeEach(() => {
  for (const f of Object.values(w.live)) if (typeof f === "function") (f as any).mockReset();
  sessionStorage.clear();
  nav.qs = "";
  resetDemoNetworks();
  setDemo(true);
});
afterEach(() => {
  cleanup();
  exitDemo();
});

describe("the demo's sample set", () => {
  it("HyperEVM: WHYPE / USDC (both styles), kHYPE / WHYPE (pegged loop), USDC / WHYPE (WHYPE lending) and kHYPE / USDC (both styles), several maturities each", () => {
    setChainChoice(998);
    const s = dataset(998);
    const byMarket = (asset: string, quote: string, kind: number) => s.open.filter((p) => sym(998, p.asset) === asset && sym(998, p.quote) === quote && p.kind === kind);
    expect(s.markets.size).toBe(7);
    expect(s.openMarkets.size).toBe(7);
    expect(byMarket("WHYPE", "USDC", Kind.American)).toHaveLength(15);
    expect(byMarket("WHYPE", "USDC", Kind.European)).toHaveLength(4);
    expect(byMarket("kHYPE", "WHYPE", Kind.American)).toHaveLength(6);
    expect(byMarket("USDC", "WHYPE", Kind.American)).toHaveLength(6);
    expect(byMarket("USDC", "WHYPE", Kind.European)).toHaveLength(2);
    // kHYPE / USDC: two buy-back prices (~87% and ~92% of kHYPE's value), four maturities any time, two at maturity
    expect(byMarket("kHYPE", "USDC", Kind.American)).toHaveLength(8);
    expect(byMarket("kHYPE", "USDC", Kind.European)).toHaveLength(4);
    expect(new Set(byMarket("kHYPE", "USDC", Kind.American).map((p) => p.strike)).size).toBe(2);
    expect(s.open).toHaveLength(45);
    // one pool in its repayment window and one closed, both WHYPE / USDC
    expect(s.notClosed).toHaveLength(46);
    expect(s.pools).toHaveLength(47);
    for (const m of [byMarket("WHYPE", "USDC", 0), byMarket("kHYPE", "WHYPE", 0), byMarket("USDC", "WHYPE", 0), byMarket("kHYPE", "USDC", 0)]) expect(new Set(m.map((p) => p.expiry)).size).toBeGreaterThanOrEqual(3);
    // every pair of the network's four tokens: five lending pairs + HYPE / WHYPE, which is a 1:1 wrap, not a market
    const pairs = new Set(s.pools.map((p) => [sym(998, p.asset), sym(998, p.quote)].sort().join("/")));
    expect([...pairs].sort()).toEqual(["USDC/WHYPE", "USDC/kHYPE", "WHYPE/kHYPE"]);
    // loop markets (either repay style): the pegged one first, then the coin's own
    expect(s.loopOpen).toHaveLength(6 + 15 + 4);
    expect(isPegged(s.loopOpen[0]!)).toBe(true);
    expect(sym(998, s.loopOpen[0]!.asset)).toBe("kHYPE");
    expect(sym(998, s.loopOpen[s.loopOpen.length - 1]!.asset)).toBe("WHYPE");
  });

  it("Monad: WMON / USDC (both styles), shMON / WMON and shMON / USDC (both styles), several maturities each", () => {
    setChainChoice(10143);
    const s = dataset(10143);
    const byMarket = (asset: string, quote: string, kind: number) => s.open.filter((p) => sym(10143, p.asset) === asset && sym(10143, p.quote) === quote && p.kind === kind);
    expect(s.markets.size).toBe(6);
    expect(byMarket("WMON", "USDC", Kind.American)).toHaveLength(15);
    expect(byMarket("WMON", "USDC", Kind.European)).toHaveLength(4);
    expect(byMarket("shMON", "WMON", Kind.American)).toHaveLength(8);
    expect(byMarket("shMON", "WMON", Kind.European)).toHaveLength(1);
    expect(byMarket("shMON", "USDC", Kind.American)).toHaveLength(8);
    expect(byMarket("shMON", "USDC", Kind.European)).toHaveLength(4);
    expect(s.open).toHaveLength(40);
    expect(s.notClosed).toHaveLength(41);
    const pairs = new Set(s.pools.map((p) => [sym(10143, p.asset), sym(10143, p.quote)].sort().join("/")));
    expect([...pairs].sort()).toEqual(["USDC/WMON", "USDC/shMON", "WMON/shMON"]);
    expect(s.loopOpen).toHaveLength(8 + 1 + 15 + 4);
    expect(sym(10143, s.loopOpen[0]!.asset)).toBe("shMON");
  });

  it("selectors offer exactly the tokens of open markets (plus the coin next to its wrapped token)", async () => {
    for (const chainId of [998, 10143]) {
      setChainChoice(chainId);
      const s = dataset(chainId);
      const { result, unmount } = renderHook(() => usePools(), { wrapper });
      await waitFor(() => expect(result.current.data?.length).toBe(s.pools.length), { timeout: 6000 });
      const head = (await demoClient(chainId).getBlock()) as { number: bigint; timestamp: bigint };
      const pairs = pairsOf(result.current.data!, Number(head.timestamp), head.number);
      unmount();
      // every pair offered has open pools behind it, and every open market's pair is offered
      expect(pairs.every((p) => p.openPools > 0)).toBe(true);
      const offered = new Set(pairs.map((p) => `${p.asset}/${p.quote}`.toLowerCase()));
      const fromOpen = new Set(s.open.map((p) => `${p.asset}/${p.quote}`.toLowerCase()));
      expect(offered).toEqual(fromOpen);
      const tokens = new Set(pairs.flatMap((p) => [sym(chainId, p.asset), sym(chainId, p.quote)]));
      expect([...tokens].sort()).toEqual(chainId === 998 ? ["USDC", "WHYPE", "kHYPE"] : ["USDC", "WMON", "shMON"]);
      // the selectors: the tokens of open markets on each side, plus the coin (HYPE / MON) wherever its wrapped token is
      const wrapped = launchTokensOf(chainId).native!;
      const coin = chainId === 998 ? "HYPE" : "MON";
      const name = (a: string) => (isNative(a) ? coin : sym(chainId, a));
      const expected = (side: "asset" | "quote") => {
        const xs = [...new Set(s.open.map((p) => sym(chainId, p[side])))];
        return (xs.includes(sym(chainId, wrapped)) ? [...xs, coin] : xs).sort();
      };
      const collateral = selectorTokens(pairs, "asset", wrapped).map(name);
      const loan = selectorTokens(pairs, "quote", wrapped).map(name);
      expect([...collateral].sort()).toEqual(expected("asset"));
      expect([...loan].sort()).toEqual(expected("quote"));
      expect(new Set(collateral).size).toBe(collateral.length);
      // the coin row sits right before its wrapped token
      expect(collateral[collateral.indexOf(coin) + 1]).toBe(sym(chainId, wrapped));
      // all of the network's tokens show up across the two sides: HYPE, WHYPE, USDC, kHYPE / MON, WMON, shMON, USDC
      expect([...new Set([...collateral, ...loan])].sort()).toEqual(chainId === 998 ? ["HYPE", "USDC", "WHYPE", "kHYPE"] : ["MON", "USDC", "WMON", "shMON"]);
    }
  });
});

describe("every page lists the whole sample set", () => {
  for (const chainId of [998, 10143]) {
    const net = chainId === 998 ? "HyperEVM" : "Monad";

    it(`${net}: Borrow lists every open pool, Loop every open loop pool, each touching the wrapped coin twice`, async () => {
      setChainChoice(chainId);
      const s = dataset(chainId);
      show(<BorrowMarkets />);
      await waitFor(() => expect(rows("token-markets")).toBe(listed(chainId, s.open)), { timeout: 8000 });
      cleanup();
      show(<LoopScreen />);
      await waitFor(() => expect(rows("loop-markets")).toBe(listed(chainId, s.loopOpen as never)), { timeout: 8000 });
    }, 20_000);

    it(`${net}: Markets lists every pool that is not closed, grouped by market and pairing`, async () => {
      setChainChoice(chainId);
      const s = dataset(chainId);
      show(<MarketsScreen />);
      await waitFor(() => expect(rows("markets")).toBe(listed(chainId, s.notClosed)), { timeout: 8000 });
      const groups = [...new Map(s.notClosed.map((p) => [marketId(p.asset, p.quote, p.kind), p])).values()];
      expect(screen.getAllByTestId("markets")).toHaveLength(listed(chainId, groups));
    }, 20_000);

    it(`${net}: LP lists one slot per market, most of them held`, async () => {
      setChainChoice(chainId);
      const s = dataset(chainId);
      show(<LpScreen />);
      const ms = [...new Map(s.pools.map((p) => [marketId(p.asset, p.quote, p.kind), p])).values()];
      await waitFor(() => expect(rows("lp-pools")).toBe(listed(chainId, ms)), { timeout: 8000 });
      const d = deploymentOf(chainId)!;
      const held = [...s.markets].filter((mid) => {
        const p = s.pools.find((x) => marketId(x.asset, x.quote, x.kind) === mid)!;
        const [seat] = readCall(chainId, { address: d.seatRegistry!, functionName: "seatOf", args: [p.asset, p.quote, p.kind] }) as [{ holder: string }];
        return !/^0x0{40}$/.test(seat.holder);
      });
      expect(held.length).toBeGreaterThanOrEqual(3);
    }, 20_000);

    it(`${net}: Earn lists the network's vaults by name, a coin vault as a HYPE row and a WHYPE row`, async () => {
      setChainChoice(chainId);
      show(<EarnScreen />);
      const names =
        chainId === 998
          ? ["HYPE Pegged vault", "WHYPE Pegged vault", "HYPE Lending vault", "WHYPE Lending vault", "USDC Conservative vault", "USDC High-yield vault"]
          : ["MON Pegged vault", "WMON Pegged vault", "USDC Conservative vault", "USDC High-yield vault"];
      await waitFor(() => expect(rows("vaults")).toBe(names.length), { timeout: 8000 });
      await waitFor(() => expect(screen.getAllByTestId("vault-name").map((n) => n.textContent).sort()).toEqual([...names].sort()), { timeout: 8000 });
      // the coin's row: the coin's logo without the wrapped mark; the wrapped row: the same logo with the W mark; USDC its own
      const coin = chainId === 998 ? "HYPE" : "MON";
      for (const row of screen.getAllByTestId("vaults-row")) {
        const n = row.querySelector('[data-testid="vault-name"]')!.textContent ?? "";
        const img = row.querySelector("img")?.getAttribute("src");
        if (n.startsWith(`${coin} `)) {
          expect(img).toBe(tokenLogo(chainId, "0x0000000000000000000000000000000000000000"));
          expect(row.querySelector('[data-testid="wrapped-badge"]')).toBeNull();
        } else if (n.startsWith(`W${coin} `)) {
          expect(img).toBe(tokenLogo(chainId, "0x0000000000000000000000000000000000000000"));
          expect(row.querySelector('[data-testid="wrapped-badge"]')).not.toBeNull();
        } else {
          expect(img).toBe(tokenLogo(chainId, launchTokensOf(chainId).usdc));
          // a USDC vault lending to the coin's borrowers names both pairings
          expect(row.textContent).toMatch(new RegExp(`to ${coin} / W${coin} borrowers`));
        }
      }
    }, 20_000);

    it(`${net}: every vault's drawer reads like its list row (title, icon, deposit token, amounts)`, async () => {
      setChainChoice(chainId);
      const coin = chainId === 998 ? "HYPE" : "MON";
      const wrapped = chainId === 998 ? "WHYPE" : "WMON";
      const { result, unmount } = renderHook(() => useVaults(), { wrapper });
      await waitFor(() => expect(result.current.data?.length).toBeGreaterThan(0), { timeout: 6000 });
      const vaults = result.current.data!;
      unmount();
      show(<EarnScreen />);
      await waitFor(() => expect(rows("vaults")).toBe(listed(chainId, vaults.map((v) => ({ asset: v.quote, quote: v.quote })))), { timeout: 8000 });
      await waitFor(() => expect(screen.getByTestId("vaults").textContent).toMatch(/Pegged vault/), { timeout: 8000 });
      const shown = screen.getAllByTestId("vaults-row").map((r) => ({ name: r.querySelector('[data-testid="vault-name"]')!.textContent!, img: r.querySelector("img")?.getAttribute("src") }));
      cleanup();
      for (const v of vaults) {
        show(<VaultDrawer address={v.address} onClose={() => {}} />);
        const d = await screen.findByTestId("vault-drawer", undefined, { timeout: 6000 });
        await waitFor(() => expect(within(d).queryByTestId("vault-thesis")).not.toBeNull(), { timeout: 6000 });
        const title = d.querySelector("h2, [id]")?.textContent ?? d.textContent ?? "";
        const row = shown.find((l) => title.includes(l.name) && !shown.some((o) => o !== l && o.name.length > l.name.length && title.includes(o.name)));
        expect(row, `drawer title "${title.slice(0, 60)}" matches a list row`).toBeTruthy();
        // the header icon is the list row's icon
        expect(d.querySelector("img")?.getAttribute("src")).toBe(row!.img);
        const isCoin = row!.name.startsWith(`${coin} `);
        // the deposit token: HYPE / MON for a coin vault (WHYPE / WMON only as the selector's second row), else USDC
        const btn = within(d).getAllByRole("button").find((b) => /Pay with|Choose token/.test(b.getAttribute("aria-label") ?? "")) ?? d.querySelector(".well span.rounded-full");
        expect(btn?.textContent).toContain(isCoin ? coin : "USDC");
        if (isCoin) {
          expect(btn?.textContent).not.toContain(wrapped);
          // thesis, stats, sentences and explainer name the coin, never the wrapped token
          for (const id of ["vault-thesis", "vault-sentences", "vault-explainer"]) expect(within(d).getByTestId(id).textContent).not.toContain(wrapped);
          expect(within(d).getByTestId("vault-thesis").textContent).toContain(coin);
          fireEvent.click(btn as HTMLElement);
          const list = await screen.findByTestId("token-select");
          const syms = within(list).getAllByRole("button").map((b) => b.textContent ?? "").filter((t) => t.includes(coin));
          expect(syms[0]).toMatch(new RegExp(`^${coin}`));
          expect(syms.some((t) => t.startsWith(wrapped))).toBe(true);
        }
        cleanup();
      }
      // opened from the WHYPE / WMON row (?pay=wrapped): the same vault, named and paid in the wrapped token
      nav.qs = "pay=wrapped";
      for (const v of vaults.filter((x) => x.quote.toLowerCase() === launchTokensOf(chainId).native!.toLowerCase())) {
        show(<VaultDrawer address={v.address} onClose={() => {}} />);
        const d = await screen.findByTestId("vault-drawer", undefined, { timeout: 6000 });
        await waitFor(() => expect(within(d).queryByTestId("vault-thesis")).not.toBeNull(), { timeout: 6000 });
        const title = d.querySelector("h2, [id]")?.textContent ?? "";
        expect(title).toMatch(new RegExp(`^${wrapped} (Pegged|Lending) vault`));
        expect(shown.some((l) => l.name === title.trim())).toBe(true);
        const btn = within(d).getAllByRole("button").find((b) => /Pay with/.test(b.getAttribute("aria-label") ?? ""));
        expect(btn?.textContent).toContain(wrapped);
        cleanup();
      }
    }, 40_000);
  }
});
