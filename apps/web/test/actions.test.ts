/** Transaction builders: guards, approvals first, order params, roll-over plan, vault collect steps. */
import { describe, expect, it } from "vitest";
import { Side, Status } from "@confluere/sdk";
import { borrowFloor, borrowWrites, cancelWrite, claimWrite, lendCap, lendWrites, repayWrites, rolloverPlan, rolloverWrites, vaultCollectWrites, vaultDepositWrites, withdrawWrite, type ActionCtx } from "../src/lib/actions";
import { E18, ME, NOW, USDC, WETH, pid, row } from "./fixtures";

const CORE = "0x00000000000000000000000000000000000000d4" as const;
const asset = { address: WETH, symbol: "WETH", decimals: 18 };
const quote = { address: USDC, symbol: "USDC", decimals: 6 };

function ctx(o: { allowance?: boolean; hint?: bigint } = {}): ActionCtx & { reads: unknown[] } {
  const reads: unknown[] = [];
  return {
    reads,
    client: { readContract: async (x: unknown) => (reads.push(x), o.hint ?? 42n) } as never,
    core: CORE,
    account: ME,
    windowBlocks: 300,
    ensureAllowance: async (token, amount, spender, opt) =>
      o.allowance ? null : { label: `Approve ${opt?.symbol}`, address: token, abi: [], functionName: "approve", args: [spender, amount], simulate: false },
  };
}

const pool = row(pid("01")) as never as Parameters<typeof borrowFloor>[0] & { id: `0x${string}`; asset: `0x${string}`; quote: `0x${string}` };

describe("guards", () => {
  it("borrow floor: last price minus 1% (or the band when tighter)", () => {
    expect(borrowFloor(row(pid("01"), { lastClearingPrice: 2900_000000n }) as never)).toBe(2871_000000n);
    expect(borrowFloor(row(pid("01"), { lastClearingPrice: 1000_000000n, bandBps: 50 }) as never)).toBe(995_000000n);
  });
  it("lend cap: last price plus 1%, never above 99% of the buy-back price", () => {
    expect(lendCap(row(pid("01"), { lastClearingPrice: 2900_000000n }) as never)).toBe(2929_000000n);
    expect(lendCap(row(pid("01"), { lastClearingPrice: 2990_000000n }) as never)).toBe(2970_000000n);
    expect(lendCap(row(pid("01"), { lastClearingPrice: 0n }) as never)).toBe(2970_000000n);
  });
});

describe("borrowWrites", () => {
  it("at-price: approve the collateral, then an at-price sell with the floor and no hint read", async () => {
    const c = ctx();
    const w = await borrowWrites(c, { pool: row(pid("01")) as never, units: E18, asset });
    expect(w.map((x) => x.label)).toEqual(["Approve WETH", "Borrow"]);
    const p = (w[1]!.args as any[])[1];
    expect([p.side, p.units, p.limit, p.budget, p.hint]).toEqual([Side.NcSell, E18, 2871_000000n, 0n, 0n]);
    expect(c.reads).toHaveLength(0);
  });
  it("a pool that never traded needs a limit, and then uses a sorted hint", async () => {
    const unpriced = row(pid("02"), { lastClearingPrice: 0n }) as never;
    await expect(borrowWrites(ctx(), { pool: unpriced, units: E18, asset })).rejects.toThrow(/no price yet/);
    const w = await borrowWrites(ctx({ allowance: true, hint: 7n }), { pool: unpriced, units: E18, asset, mode: "limit", limit: 2500_000000n });
    expect(w).toHaveLength(1);
    expect((w[0]!.args as any[])[1]).toMatchObject({ side: Side.Sell, limit: 2500_000000n, hint: 7n });
    expect(w[0]!.refresh).toBeTypeOf("function");
  });
});

describe("lendWrites", () => {
  it("at-price: budget in quote, capped price, approve the budget", async () => {
    const w = await lendWrites(ctx(), { pool: row(pid("01")) as never, amount: 1000_000000n, quote });
    expect(w.map((x) => x.label)).toEqual(["Approve USDC", "Lend"]);
    expect((w[0]!.args as any[])[1]).toBe(1000_000000n);
    expect((w[1]!.args as any[])[1]).toMatchObject({ side: Side.NcBuy, units: 0n, budget: 1000_000000n, limit: 2929_000000n });
  });
  it("limit: escrow covers units at the limit plus the rounding reserve", async () => {
    const w = await lendWrites(ctx(), { pool: row(pid("01")) as never, amount: 0n, quote, mode: "limit", units: E18, limit: 2800_000000n, ttl: 4 });
    expect((w[0]!.args as any[])[1]).toBe(2800_000004n);
    expect((w[1]!.args as any[])[1]).toMatchObject({ side: Side.Buy, units: E18, limit: 2800_000000n, hint: 42n });
  });
});

describe("repay, claim, withdraw, cancel", () => {
  it("repay approves the buy-back amount (rounded up)", async () => {
    const w = await repayWrites(ctx(), { pool: row(pid("01")) as never, units: E18 / 3n, quote });
    expect((w[0]!.args as any[])[1]).toBe(1000_000000n);
    expect(w[1]).toMatchObject({ label: "Repay", functionName: "repay" });
  });
  it("claim / withdraw / cancel target the core", () => {
    expect(claimWrite({ core: CORE }, row(pid("01")) as never)).toMatchObject({ functionName: "claim", args: [pid("01")] });
    expect(withdrawWrite({ core: CORE, account: ME }, USDC, "USDC")).toMatchObject({ label: "Withdraw USDC", args: [USDC, ME] });
    expect(cancelWrite({ core: CORE }, pid("01"), 9n)).toMatchObject({ functionName: "cancelOrder", args: [pid("01"), 9n] });
  });
});

describe("rollover", () => {
  const from = row(pid("01"), { strike: 3000_000000n }) as never;
  const to = row(pid("02"), { expiry: NOW + 10 * 86_400, strike: 3000_000000n, lastClearingPrice: 2900_000000n, batchInterval: 120 }) as never;
  it("plan: floor from the new pool's price, top-up for the gap, ttl within bounds", () => {
    const p = rolloverPlan({ from, to, units: E18, now: NOW, spb: 1 }, 300);
    expect(p.minPrice).toBe(2871_000000n);
    expect(p.maxTopUp).toBe(129_000000n + 2n * BigInt(p.ttl));
    expect(p.ttl).toBeGreaterThanOrEqual(200);
    expect(p.tries).toBe(2);
  });
  it("writes: approve the top-up, then rollover with a hint", async () => {
    const w = await rolloverWrites(ctx(), { from, to, units: E18, quote, now: NOW, spb: 1 });
    expect(w.map((x) => x.label)).toEqual(["Approve USDC", "Extend"]);
    expect((w[1]!.args as any[]).slice(0, 4)).toEqual([pid("01"), pid("02"), E18, 2871_000000n]);
  });
  it("an unpriced target needs a floor", async () => {
    await expect(rolloverWrites(ctx(), { from, to: row(pid("03"), { lastClearingPrice: 0n, status: Status.Open }) as never, units: E18, quote, now: NOW, spb: 1 })).rejects.toThrow(/no price yet/);
  });
});

describe("vaults", () => {
  const V = "0x00000000000000000000000000000000000000c7" as const;
  it("deposit approves the vault, then requests", async () => {
    const w = await vaultDepositWrites(ctx(), { vault: V, quote, amount: 5n });
    expect(w.map((x) => [x.label, x.address])).toEqual([["Approve USDC", USDC], ["Deposit", V]]);
    expect(w[1]!.args).toEqual([5n, ME, ME]);
  });
  it("collect only includes steps with something to collect", () => {
    expect(vaultCollectWrites({ account: ME }, V, { claimShares: 0n, claimAssets: 0n, assetCredits: [] }, "USDC")).toEqual([]);
    const w = vaultCollectWrites({ account: ME }, V, { claimShares: 1n, claimAssets: 2n, assetCredits: [{ amount: 3n }] }, "USDC");
    expect(w.map((x) => x.functionName)).toEqual(["mint", "withdraw", "claimAssets"]);
  });
});

void pool;
