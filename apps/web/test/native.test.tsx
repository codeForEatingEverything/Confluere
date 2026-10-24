// @vitest-environment jsdom
/**
 * IA v3.1 item 11: the network's own coin (HYPE on HyperEVM) is a selectable asset next to WHYPE. Paying in it puts one
 * wrap step in front of the same action; there is no separate wrap feature. Also: loops work on the coin's own market
 * (no staked token needed), the home card's Maturity / Pool selectors and Loop mode, and empty states that never send
 * the person to the other network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Kind, Status } from "@confluere/sdk";
import { DS, E18, LST, ME, NAT, NOW, TOKENS, USDC, pid, resetDS, row, wrap } from "./fixtures";

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
import { LoopScreen } from "../src/components/loop/LoopScreen";
import { NothingOpen } from "../src/components/borrow/BorrowEmpty";
import { LendForm } from "../src/components/borrow/LendForm";
import { defaultPair } from "../src/components/home/BorrowSwap";
import { routeLoop } from "../src/components/home/LoopSwap";
import { borrowWrites, lendWrites, repayWrites, vaultDepositWrites, type ActionCtx } from "../src/lib/actions";
import { isLoopMarket } from "../src/lib/loop";
import { gasReserve, isNative, isWrappedNative, nativeTokenOf, spendableNative } from "../src/lib/native";

/** HyperEVM testnet's real WHYPE (lib/native reads the SDK deployment of chain 998). */
const WHYPE = "0x5555555555555555555555555555555555555555" as const;
(TOKENS as any)[WHYPE] = { address: WHYPE, symbol: "WHYPE", decimals: 18 };

const hypePool = (id: string, over: Record<string, unknown> = {}) => row(pid(id), { asset: WHYPE, quote: USDC, strike: 40_000000n, lastClearingPrice: 38_000000n, bandBase: 38_000000n, vwap: 38_000000n, ...over });

/** The open token list (closed modals stay in the DOM, empty). */
const openList = () => screen.getAllByTestId("token-select").find((d) => d.querySelector("[data-token-row]"))!;
const rowsOf = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>("[data-token-row]"));

const ctx = (): ActionCtx =>
  ({
    client: { readContract: async () => 42n } as never,
    core: "0x00000000000000000000000000000000000000d4",
    account: ME,
    windowBlocks: 300,
    ensureAllowance: async (token: string, amount: bigint, spender: string, o?: { symbol?: string }) => ({ label: `Approve ${o?.symbol}`, address: token, abi: [], functionName: "approve", args: [spender, amount], simulate: false }),
  }) as never;

beforeEach(() => {
  resetDS();
  DS.pools = [hypePool("h1"), hypePool("h2", { strike: 42_000000n, lastClearingPrice: 39_000000n }), row(pid("w1"))];
  DS.balances = { [WHYPE]: 0n, [USDC]: 1000_000000n };
  DS.minNotional = 1_000000n;
});
afterEach(cleanup);

describe("lib/native (pure)", () => {
  it("HYPE is the zero address, wraps into the deployment's WHYPE, and Max keeps gas back", () => {
    expect(nativeTokenOf(998)).toEqual({ address: "0x0000000000000000000000000000000000000000", symbol: "HYPE", decimals: 18 });
    expect(isNative("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isWrappedNative(998, WHYPE)).toBe(true);
    expect(isWrappedNative(998, USDC)).toBe(false);
    expect(spendableNative(5n * E18, 998)).toBe(5n * E18 - gasReserve(998));
    expect(spendableNative(1n, 998)).toBe(0n);
  });

  it("ETH on Sepolia: the same coin row, a 0.01 ETH gas reserve", () => {
    expect(nativeTokenOf(11155111)).toEqual({ address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 });
    expect(gasReserve(11155111)).toBe(10n ** 16n);
    expect(spendableNative(E18, 11155111)).toBe(E18 - 10n ** 16n);
  });

  it("paying in the coin puts the wrap first, then the approval, then the action; otherwise nothing changes", async () => {
    const pool = hypePool("h1") as never;
    const whype = { address: WHYPE, symbol: "WHYPE", decimals: 18 };
    const usdc = { address: USDC, symbol: "USDC", decimals: 6 };
    const b = await borrowWrites(ctx(), { pool, units: 2n * E18, asset: whype, payNative: "HYPE" });
    expect(b.map((w) => w.label)).toEqual(["Wrap HYPE", "Approve WHYPE", "Borrow"]);
    expect(b[0]).toMatchObject({ address: WHYPE, functionName: "deposit", value: 2n * E18 });
    expect((await borrowWrites(ctx(), { pool, units: 2n * E18, asset: whype })).map((w) => w.label)).toEqual(["Approve WHYPE", "Borrow"]);

    const wmonPool = row(pid("m1"), { asset: LST, quote: WHYPE, strike: E18, lastClearingPrice: (E18 * 99n) / 100n }) as never;
    const l = await lendWrites(ctx(), { pool: wmonPool, amount: 3n * E18, quote: whype, payNative: "HYPE" });
    expect(l.map((w) => w.label)).toEqual(["Wrap HYPE", "Approve WHYPE", "Lend"]);
    expect(l[0]!.value).toBe(3n * E18);
    const r = await repayWrites(ctx(), { pool: wmonPool, units: 2n * E18, quote: whype, payNative: "HYPE" });
    expect(r[0]).toMatchObject({ functionName: "deposit", value: 2n * E18 });
    const v = await vaultDepositWrites(ctx(), { vault: "0x00000000000000000000000000000000000000c8", quote: whype, amount: E18, payNative: "HYPE" });
    expect(v.map((w) => w.label)).toEqual(["Wrap HYPE", "Approve WHYPE", "Deposit"]);
    expect((await lendWrites(ctx(), { pool: hypePool("h1") as never, amount: 100_000000n, quote: usdc })).map((w) => w.label)).toEqual(["Approve USDC", "Lend"]);
  });

  it("the home card's default pair is the coin's market, never a staked token", () => {
    const pairs = [
      { asset: LST, quote: NAT, openPools: 5 },
      { asset: WHYPE, quote: USDC, openPools: 2 },
    ];
    expect(defaultPair(pairs, WHYPE)?.asset).toBe(WHYPE);
    expect(defaultPair(pairs, undefined)?.asset).toBe(LST);
    expect(defaultPair([{ ...pairs[1]!, openPools: 0 }, pairs[0]!], WHYPE)?.asset).toBe(LST);
  });

  it("loop markets: either repay style, on the coin or a staked token", () => {
    expect(isLoopMarket(hypePool("h1") as never, 998)).toBe(true);
    expect(isLoopMarket(hypePool("h1", { kind: Kind.European }) as never, 998)).toBe(true);
    expect(isLoopMarket(row(pid("w1")) as never, 998)).toBe(false);
    expect(isLoopMarket(row(pid("l1"), { asset: LST, quote: NAT, bandBps: 150 }) as never, 998)).toBe(true);
  });

  it("loop router: the staked coin's market first, then the coin's own, then the cheapest; a pick wins while open", () => {
    const pools = [hypePool("h2", { strike: 42_000000n }), row(pid("l1"), { asset: LST, quote: NAT, bandBps: 150 }), hypePool("h1")] as never[];
    const r = routeLoop(pools, 998, NOW);
    expect(r.pool?.asset).toBe(LST);
    expect(r.pools.map((p: { asset: string }) => p.asset)).toEqual([LST, WHYPE, WHYPE]);
    expect(routeLoop(pools, 998, NOW, undefined, pid("h1")).pool?.id).toBe(pid("h1"));
  });
});

describe("home card on HyperEVM", () => {
  it("defaults to paying in HYPE with the wallet's native balance; the button wraps as its first step", () => {
    wrap(<HomeScreen />);
    const card = screen.getByTestId("borrow-swap");
    expect(within(card).getAllByTestId("token-button")[0]!.textContent).toMatch(/^HYPE/);
    expect(card.textContent).toMatch(/Balance 5\.00 HYPE/);
    fireEvent.change(screen.getByTestId("pay-input"), { target: { value: "1" } });
    expect(screen.getByTestId("borrow-button").textContent).toBe("Wrap HYPE and borrow");
    fireEvent.change(screen.getByTestId("pay-input"), { target: { value: "5" } });
    expect(screen.getByTestId("borrow-button").textContent).toBe("Not enough HYPE");
  });

  it("the token list has HYPE and WHYPE side by side; WHYPE pays without a wrap", () => {
    DS.balances = { [WHYPE]: 3n * E18, [USDC]: 0n };
    wrap(<HomeScreen />);
    fireEvent.click(within(screen.getByTestId("borrow-swap")).getAllByTestId("token-button")[0]!);
    const rows = rowsOf(openList());
    expect(rows.map((r) => r.textContent?.match(/(WHYPE|HYPE|WETH)/)?.[0])).toEqual(["HYPE", "WHYPE", "WETH"]);
    expect(rows[0]!.textContent).toMatch(/5\.00/);
    fireEvent.click(rows[1]!);
    fireEvent.change(screen.getByTestId("pay-input"), { target: { value: "1" } });
    expect(screen.getByTestId("borrow-button").textContent).toMatch(/^Borrow 38\.00 USDC/);
  });

  it("short of WHYPE but holding HYPE: offers to pay with HYPE instead, never a separate wrap button", () => {
    DS.need = { balance: 0n, nativeBalance: 5n * E18, missing: E18, step: { kind: "wrap", token: WHYPE, native: "HYPE", label: "Wrap HYPE" } };
    wrap(<HomeScreen />);
    fireEvent.click(within(screen.getByTestId("borrow-swap")).getAllByTestId("token-button")[0]!);
    fireEvent.click(rowsOf(openList())[1]!);
    fireEvent.change(screen.getByTestId("pay-input"), { target: { value: "1" } });
    expect(screen.getByTestId("borrow-button").textContent).toBe("Not enough WHYPE");
    expect(screen.queryByRole("button", { name: /^Wrap$/ })).toBeNull();
    fireEvent.click(screen.getByTestId("use-native"));
    expect(screen.getByTestId("borrow-button").textContent).toBe("Wrap HYPE and borrow");
  });

  it("offers a Loop mode where a loop market exists, with its own Maturity and Pool selectors", () => {
    wrap(<HomeScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Loop" }));
    expect(screen.getByTestId("loop-selectors")).toBeTruthy();
    const card = screen.getByTestId("loop-card");
    expect(card.textContent).toMatch(/Borrow USDC against HYPE, turn it back into HYPE, repeat\./);
    expect(card.textContent).toMatch(/Turn it into HYPE where you usually trade/);
    expect(card.textContent).not.toMatch(/FastLane|Stake/);
  });

  it("no Loop mode on a network without a loop market", () => {
    DS.pools = [row(pid("w1"))];
    wrap(<HomeScreen />);
    expect(screen.queryByRole("tab", { name: "Loop" })).toBeNull();
  });
});

describe("lending in a market priced in WHYPE", () => {
  it("pays in HYPE by default, with the wrap as the first step of the same button; WHYPE stays selectable", () => {
    (TOKENS as any)[LST] = { address: LST, symbol: "kHYPE", decimals: 18 };
    DS.pools = [row(pid("k1"), { asset: LST, quote: WHYPE, strike: E18, lastClearingPrice: (E18 * 99n) / 100n, bandBps: 150 })];
    DS.minNotional = 10n ** 16n;
    wrap(<LendForm poolId={pid("k1")} embedded />);
    expect(screen.getByTestId("token-button").textContent).toMatch(/HYPE/);
    expect(screen.getByTestId("token-button").textContent).not.toMatch(/WHYPE/);
    fireEvent.change(screen.getByTestId("lend-input"), { target: { value: "1" } });
    expect(screen.getByTestId("lend-button").textContent).toBe("Wrap HYPE and lend");
    fireEvent.click(screen.getByTestId("token-button"));
    fireEvent.click(rowsOf(openList())[1]!);
    expect(screen.getByTestId("lend-button").textContent).toBe("Not enough WHYPE");
  });
});

describe("loop page and empty states", () => {
  it("lists the coin's own market that repays any time, as both pairings (HYPE / USDC, WHYPE / USDC); no staked token needed", () => {
    wrap(<LoopScreen />);
    const rows = screen.getAllByTestId("loop-markets-row");
    // two pools, each twice: the native pairing right before the on-chain one
    expect(rows).toHaveLength(4);
    const names = rows.map((r) => r.querySelector('[data-testid="market-pair"]')!.textContent);
    expect(names).toEqual(["HYPE / USDC", "WHYPE / USDC", "HYPE / USDC", "WHYPE / USDC"]);
  });

  it("an empty network never points to the other network", () => {
    DS.pools = [row(pid("w1"))];
    const { unmount } = wrap(<LoopScreen />);
    expect(screen.getByText("No loop markets on HyperEVM Testnet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Monad/);
    unmount();
    DS.pools = [row(pid("z1"), { status: Status.Closed })];
    wrap(<NothingOpen what="borrow" closedTerms={1} lastExpiry={NOW - 60} />);
    expect(screen.getByText(/The next maturity opens soon/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See matured markets" }).getAttribute("href")).toBe("/borrow?closed=1");
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
  });
});
