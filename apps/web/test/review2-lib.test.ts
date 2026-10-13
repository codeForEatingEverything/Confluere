/** Pure rules added in the second review: cancel cut-off, seat lock, rollover, purge, seats, theme. */
import { describe, expect, it, vi } from "vitest";
import { Side, Status } from "@confluere/sdk";
import { NOW, pid, row } from "./fixtures";

vi.mock("@/lib/config", async () => (await import("./fixtures")).configMock());

import { canRollover, cancelCutoff, cutoffEndsIn, lockablePools, seatLockState, windowOpen } from "../src/lib/window";
import { deadOrders, poolDue, rolloverDead, rolloverOldOf } from "../src/lib/due";
import { quotedScanFrom, quotedScanRanges, seatLockLookback, seatOrderKeys, type QuotedScan } from "../src/lib/data";
import { holderUnsplitShare, obligationValue } from "../src/lib/seats";
import { rolloverTries, rolloverTtl, ROLLOVER_TTL } from "../src/lib/rollover";
import { APPKIT_THEME_VARIABLES, appKitThemeOptions } from "../src/lib/appkitTheme";

const IV = 21_600; // a 6 h long-tail batch
const longTail = (over: Record<string, unknown> = {}) => row(pid("aa"), { cadence: 1, batchInterval: IV, nextBatchAt: NOW + 3600, ...over }) as any;
const sell = (over: Record<string, unknown> = {}) => ({ side: Side.Sell, deadline: 10, ...over });

describe("cancel cut-off mirrors OrderLogic.cancelOrder", () => {
  it("off for mainstream pools, bids, expired orders, past expiry and non-Open pools", () => {
    expect(cancelCutoff(longTail({ cadence: 0, nextBatchAt: NOW - 1 }), sell(), NOW, 1000n)).toBe(false);
    expect(cancelCutoff(longTail({ nextBatchAt: NOW - 1 }), sell({ side: Side.Bid }), NOW, 1000n)).toBe(false);
    expect(cancelCutoff(longTail({ nextBatchAt: NOW - 1 }), sell({ deadline: 3 }), NOW, 1000n)).toBe(false); // deadline <= settleCount 3
    expect(cancelCutoff(longTail({ nextBatchAt: NOW - 1, expiry: NOW }), sell(), NOW, 1000n)).toBe(false);
    expect(cancelCutoff(longTail({ nextBatchAt: NOW - 1, status: Status.Window }), sell(), NOW, 1000n)).toBe(false);
  });

  it("a passed batch that nobody settled locks cancels until someone settles", () => {
    expect(cancelCutoff(longTail({ nextBatchAt: NOW }), sell(), NOW, 1000n)).toBe("due"); // boundary itself
    expect(cancelCutoff(longTail({ nextBatchAt: NOW - 3 * IV }), sell(), NOW, 1000n)).toBe("due");
  });

  it("while paused the unsettled-batch rule is off; only the running batch's last twelfth counts", () => {
    const paused = { pausedUntil: 5000n };
    // three batches unsettled, now in the middle of the running batch: free to cancel
    expect(cancelCutoff(longTail({ ...paused, nextBatchAt: NOW - 2 * IV - IV / 2 }), sell(), NOW, 1000n)).toBe(false);
    // the running batch ends in 100 s (< IV/12 = 1800 s): cut-off
    expect(cancelCutoff(longTail({ ...paused, nextBatchAt: NOW - IV + 100 }), sell(), NOW, 1000n)).toBe("window");
    expect(cutoffEndsIn(longTail({ ...paused, nextBatchAt: NOW - IV + 100 }), NOW)).toBe(100);
  });

  it("the last 1/12 of the batch before the boundary, inclusive, with integer division", () => {
    expect(cancelCutoff(longTail({ nextBatchAt: NOW + IV / 12 }), sell(), NOW, 1000n)).toBe("window");
    expect(cancelCutoff(longTail({ nextBatchAt: NOW + IV / 12 + 1 }), sell(), NOW, 1000n)).toBe(false);
    expect(cancelCutoff(longTail({ batchInterval: 25, nextBatchAt: NOW + 3 }), sell(), NOW, 1000n)).toBe(false); // 25/12 → 2
    expect(cancelCutoff(longTail({ batchInterval: 25, nextBatchAt: NOW + 2 }), sell(), NOW, 1000n)).toBe("window");
  });
});

describe("seat lock", () => {
  const p = row(pid("aa")) as any;
  const o = { id: 2n, deadline: 10 };
  it("unknown until the scan answers; a failed scan is not a lock; only live orders of open pools can be locked", () => {
    expect(seatLockState({}, p, o, NOW, true)).toBe("unknown");
    expect(seatLockState({ isError: true }, p, o, NOW, true)).toBe(false);
    expect(seatLockState({ data: new Set([`${p.id}:2`]) }, p, o, NOW, true)).toBe(true);
    expect(seatLockState({ data: new Set() }, p, o, NOW, true)).toBe(false);
    expect(seatLockState({}, p, { id: 2n, deadline: 3 }, NOW, true)).toBe(false);
    expect(seatLockState({}, { ...p, status: Status.Window }, o, NOW, true)).toBe(false);
    expect(seatLockState({}, p, o, NOW, false)).toBe(false);
    expect(lockablePools([p, p, { ...p, id: pid("bb"), expiry: NOW - 1 }], NOW)).toHaveLength(1);
  });

  it("the Quoted scan covers only the window a still-locked order can come from", () => {
    // grid horizon (period × maxExpiries) caps it; otherwise MAX_TTL batches of the slowest pool
    expect(seatLockLookback([{ batchInterval: 120 }], { period: 3600, maxExpiries: 8 })).toBe(8 * 3600);
    expect(seatLockLookback([{ batchInterval: 1 }, { batchInterval: 2 }], { period: 86_400, maxExpiries: 8 })).toBe(2000);
    // 28,800 s at 0.4 s/block (+25%) = 90,000 blocks back from the head, not from the deploy block
    expect(quotedScanFrom({ head: 1_000_000n, deployBlock: 10n, lookbackS: 28_800, spb: 0.4 })).toBe(910_000n);
    expect(quotedScanFrom({ head: 1_000_000n, deployBlock: 950_000n, lookbackS: 28_800, spb: 0.4 })).toBe(950_000n);
    expect(quotedScanFrom({ head: 1_000_000n, deployBlock: 10n, lookbackS: 28_800, spb: null })).toBe(10n);
    // only new blocks once scanned; a caller that needs to start earlier also gets the gap before the earliest block read
    expect(quotedScanRanges(910_000n, 1_000_000n, { from: -1n, to: -1n })).toEqual([[910_000n, 1_000_000n]]);
    expect(quotedScanRanges(910_000n, 1_000_000n, { from: 910_000n, to: 999_000n })).toEqual([[999_001n, 1_000_000n]]);
    expect(quotedScanRanges(500_000n, 1_000_000n, { from: 910_000n, to: 999_000n })).toEqual([
      [500_000n, 909_999n],
      [999_001n, 1_000_000n],
    ]);
    expect(quotedScanRanges(950_000n, 999_000n, { from: 910_000n, to: 999_000n })).toEqual([]);
  });

  it("a later, longer lookback backfills blocks the first (shorter) scan skipped", async () => {
    // Quoted logs at block 100 (old, only inside the long-tail lookback) and block 950 (recent)
    const posted = [
      { block: 100n, args: { poolId: pid("aa"), orderId: 7n } },
      { block: 950n, args: { poolId: pid("aa"), orderId: 8n } },
    ];
    const calls: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return posted.filter((l) => l.block >= fromBlock && l.block <= toBlock);
      },
    } as any;
    const st: QuotedScan = { from: -1n, to: -1n, keys: new Set() };
    const d = { seatRegistry: pid("cc").slice(0, 42) as any, deployBlock: 1 };
    // mainstream pool first: 80 s at 1 s/block (+25%) = 100 blocks back
    const first = await seatOrderKeys(client, 80, 1, st, d);
    expect(first.has(`${pid("aa")}:8`)).toBe(true);
    expect(first.has(`${pid("aa")}:7`)).toBe(false);
    expect(st.from).toBe(900n);
    // long-tail pool / full Portfolio next: 800 s → 1000 blocks back, clamped to the deploy block
    const second = await seatOrderKeys(client, 800, 1, st, d);
    expect(second.has(`${pid("aa")}:7`)).toBe(true);
    expect(st.from).toBe(1n);
    expect(st.to).toBe(1000n);
    // the backfill never re-reads blocks already covered
    expect(calls.every(([lo, hi]) => hi < 900n || lo >= 900n)).toBe(true);
  });

  it("a long pause does not leave an unread hole that a later, longer lookback skips", async () => {
    // a Quoted log at block 400, posted while nobody was scanning
    const posted = [{ block: 400n, args: { poolId: pid("aa"), orderId: 9n } }];
    let head = 200n;
    const calls: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => head,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        return posted.filter((l) => l.block >= fromBlock && l.block <= toBlock);
      },
    } as any;
    const st: QuotedScan = { from: -1n, to: -1n, keys: new Set() };
    const d = { seatRegistry: pid("cc").slice(0, 42) as any, deployBlock: 1 };
    // 80 s at 1 s/block (+25%) = 100 blocks back: reads [100, 200]
    await seatOrderKeys(client, 80, 1, st, d);
    expect([st.from, st.to]).toEqual([100n, 200n]);
    // tab in the background until head 600; the same short lookback now starts at 500
    head = 600n;
    await seatOrderKeys(client, 80, 1, st, d);
    expect(st.from).toBe(500n); // not 100: blocks 201..499 were never read
    expect(st.to).toBe(600n);
    // a long-tail pool next: 240 s → 300 blocks back, start 300; blocks 300..499 must be read now
    const keys = await seatOrderKeys(client, 240, 1, st, d);
    expect(keys.has(`${pid("aa")}:9`)).toBe(true);
    expect([st.from, st.to]).toEqual([300n, 600n]);
    expect(calls.some(([lo, hi]) => lo <= 400n && hi >= 400n)).toBe(true);
  });
});

describe("rollover", () => {
  it("can be marked while the old pool trades before expiry or while its window is open (OrderLogic.rollover)", () => {
    expect(canRollover(row(pid("aa")) as any, NOW, 1000n)).toBe(true);
    expect(canRollover(row(pid("aa"), { status: Status.Window, windowEnd: 1200n }) as any, NOW, 1000n)).toBe(true);
    expect(canRollover(row(pid("aa"), { status: Status.Window, windowEnd: 900n }) as any, NOW, 1000n)).toBe(false);
    expect(canRollover(row(pid("aa"), { expiry: NOW - 10, expiryWindowEnd: 900n }) as any, NOW, 1000n)).toBe(false);
    expect(canRollover(row(pid("aa"), { status: Status.Closed }) as any, NOW, 1000n)).toBe(false);
  });

  it("tries come from the window length and the batch interval, not a fixed four", () => {
    expect(rolloverTries(300, 1, 120)).toBe(2); // demo grid: 300 blocks × 1 s / 120 s batches
    expect(rolloverTries(7200, 1, 1800)).toBe(4); // production HyperEVM: 2 h / 30 min
    expect(rolloverTries(300, null, 120)).toBeUndefined();
  });

  it("ttl covers the batches until expiry plus the window's tries, between 200 and MAX_TTL", () => {
    expect(rolloverTtl({ now: NOW, fromExpiry: NOW - 10, targetInterval: 120, tries: 2 })).toEqual({ ttl: ROLLOVER_TTL, capped: false });
    expect(rolloverTtl({ now: NOW, fromExpiry: NOW + 300 * 120, targetInterval: 120, tries: 2 })).toEqual({ ttl: 306, capped: false });
    expect(rolloverTtl({ now: NOW, fromExpiry: NOW + 2000 * 120, targetInterval: 120, tries: 2 })).toEqual({ ttl: 1000, capped: true });
  });

  it("purge: a rollover order whose old window is over for good is dead (keeper plan.ts rolloverDead)", () => {
    const old = (over: Record<string, unknown>) => row(pid("01"), over) as any;
    expect(rolloverDead(old({}), NOW, 1000n)).toBe(false); // old pool still trading
    expect(rolloverDead(old({ status: Status.Window, windowEnd: 1200n }), NOW, 1000n)).toBe(false);
    expect(rolloverDead(old({ status: Status.Window, windowEnd: 900n }), NOW, 1000n)).toBe(true);
    expect(rolloverDead(old({ expiry: NOW - 10, expiryWindowEnd: 900n }), NOW, 1000n)).toBe(true);
    expect(rolloverDead(old({ expiry: NOW - 10, expiryWindowEnd: 0n }), NOW, 1000n)).toBe(false); // window not started
    expect(windowOpen(old({ expiry: NOW - 10, expiryWindowEnd: 0n }), NOW, 1000n)).toBe(true);

    const pools = [old({ status: Status.Closed, windowEnd: 900n }), row(pid("02")) as any];
    const sources = new Map([[`${pid("02")}:7`, pid("01")]]);
    const lookup = rolloverOldOf(pid("02"), sources, pools);
    const orders = [
      { id: 7n, side: Side.Sell, deadline: 50 },
      { id: 8n, side: Side.Sell, deadline: 50 },
    ];
    expect(deadOrders(orders, 3, false, lookup, NOW, 1000n)).toEqual([7n]);
    expect(deadOrders(orders, 3, false)).toEqual([]);
    const due = poolDue(pools[1], NOW, 1000n, orders as any, lookup);
    expect(due).toEqual({ action: "purge", dead: [7n] });
  });
});

describe("seats", () => {
  const pool = { lastClearingPrice: 0n, strike: 3000_000000n, assetDecimals: 18 };
  it("obligation value: at K, a pre-trade lend order below K at its limit (SeatRegistry.postOrder)", () => {
    const E18 = 10n ** 18n;
    expect(obligationValue(E18, 2000_000000n, pool, true)).toBe(2000_000000n);
    expect(obligationValue(E18, 2000_000000n, pool, false)).toBe(3000_000000n);
    expect(obligationValue(E18, 4000_000000n, pool, true)).toBe(3000_000000n);
    expect(obligationValue(E18, 2000_000000n, { ...pool, lastClearingPrice: 2900_000000n }, true)).toBe(3000_000000n);
  });

  it("the holder's unsplit fee share is seatShareBps of marketFees − feesSplit; nobody else has one", () => {
    const holder = "0x00000000000000000000000000000000000000e1";
    const s = { holder: holder as `0x${string}`, unsplit: 1000_000000n, shareBps: 3500 };
    expect(holderUnsplitShare(s, holder)).toBe(350_000000n);
    expect(holderUnsplitShare(s, "0x00000000000000000000000000000000000000f2")).toBe(0n);
    expect(holderUnsplitShare(s, undefined)).toBe(0n);
  });
});

describe("chrome", () => {
  it("AppKit takes the site's font (so it never preloads fonts.reown.com), accent, radius and theme", () => {
    const o = appKitThemeOptions("dark");
    expect(o.themeMode).toBe("dark");
    expect(o.themeVariables["--w3m-font-family"]).toMatch(/var\(--font-geist\)/);
    expect(APPKIT_THEME_VARIABLES["--w3m-accent"]).toBe("var(--brand)");
    expect(APPKIT_THEME_VARIABLES["--w3m-border-radius-master"]).toBe("4px");
  });

});
