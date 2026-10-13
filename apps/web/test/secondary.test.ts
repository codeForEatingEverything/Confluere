/** Pure parts of the position market (lib/secondary): rounding, best-first order, take planning, trading gates, builders. */
import { describe, expect, it } from "vitest";
import { Status } from "@confluere/sdk";
import type { Address, Hex } from "viem";
import {
  avgPrice,
  buyNowWrites,
  cancelWrite,
  costOf,
  listWrites,
  offerExpiry,
  planTakes,
  proceedsOf,
  sellNowWrites,
  sortBest,
  tokenIdOf,
  toOffers,
  tradable,
  type MarketOffer,
  type SecondaryCtx,
} from "../src/lib/secondary";

const E18 = 10n ** 18n;
const POOL = `0x${"ab".repeat(31)}a0` as Hex;
const ME = "0x00000000000000000000000000000000000000a1" as Address;
const YOU = "0x00000000000000000000000000000000000000b2" as Address;
const MARKET = "0x00000000000000000000000000000000000000c3" as Address;
const USDC = { address: "0x00000000000000000000000000000000000000d4" as Address, symbol: "USDC", decimals: 6 };

const offer = (id: bigint, price: bigint, units: bigint, o: Partial<MarketOffer> = {}): MarketOffer => ({
  id,
  maker: YOU,
  poolId: POOL,
  units,
  price,
  expiresAt: 0,
  isR: true,
  isBid: false,
  escrow: 0n,
  ...o,
});

describe("rounding mirrors PositionMarket", () => {
  it("buyers pay rounded up, sellers receive rounded down", () => {
    expect(costOf(1n, 3n, 18)).toBe(1n);
    expect(proceedsOf(1n, 3n, 18)).toBe(0n);
    expect(costOf(E18 / 4n, 100_000000n, 18)).toBe(25_000000n);
    expect(proceedsOf(E18 / 4n, 100_000000n, 18)).toBe(25_000000n);
    expect(costOf(3n, 1n, 0)).toBe(3n);
    expect(avgPrice(25_000000n, E18 / 4n, 18)).toBe(100_000000n);
    expect(avgPrice(0n, 0n, 18)).toBe(0n);
  });
  it("token ids: C = poolId, R = poolId | 1", () => {
    expect(tokenIdOf(POOL, false)).toBe(BigInt(POOL));
    expect(tokenIdOf(POOL, true)).toBe(BigInt(POOL) + 1n);
  });
});

describe("book order and take planning", () => {
  const NOW = 1_000;
  it("sorts asks low to high and bids high to low, dropping expired and empty offers", () => {
    const asks = [offer(1n, 30n, 5n), offer(2n, 10n, 5n), offer(3n, 20n, 5n, { expiresAt: NOW }), offer(4n, 10n, 0n), offer(5n, 10n, 1n)];
    expect(sortBest(asks, NOW).map((o) => o.id)).toEqual([2n, 5n, 1n]);
    const bids = [offer(1n, 30n, 5n, { isBid: true }), offer(2n, 50n, 5n, { isBid: true }), offer(3n, 40n, 5n, { isBid: true, expiresAt: NOW + 1 })];
    expect(sortBest(bids, NOW).map((o) => o.id)).toEqual([2n, 3n, 1n]);
  });
  it("walks the best bids, receives rounded down per take, and reports what it could not fill", () => {
    const bids = [offer(1n, 3000_000000n, E18, { isBid: true }), offer(2n, 2900_000000n, E18, { isBid: true })];
    const p = planTakes(bids, (3n * E18) / 2n, 18);
    expect(p.takes.map((t) => [t.offer.id, t.units, t.quote])).toEqual([
      [1n, E18, 3000_000000n],
      [2n, E18 / 2n, 1450_000000n],
    ]);
    expect(p.quote).toBe(4450_000000n);
    expect(p.short).toBe(0n);
    expect(p.avg).toBe((4450_000000n * E18) / ((3n * E18) / 2n));
    const big = planTakes(bids, 5n * E18, 18);
    expect(big.units).toBe(2n * E18);
    expect(big.short).toBe(3n * E18);
  });
  it("pays rounded up on asks, caps the number of offers, and skips your own", () => {
    const asks = [offer(1n, 3n, 10n, { maker: ME }), offer(2n, 3n, 1n), offer(3n, 3n, 1n), offer(4n, 3n, 1n)];
    const p = planTakes(asks, 10n, 18, { maxOffers: 2, skip: ME });
    expect(p.takes.map((t) => t.offer.id)).toEqual([2n, 3n]);
    expect(p.quote).toBe(2n); // 1 + 1, each rounded up from 3e-18
    expect(p.short).toBe(8n);
  });
  it("turns contract tuples into rows", () => {
    const rows = toOffers([7n], [{ maker: ME, units: 5n, poolId: POOL, price: 9n, expiresAt: 123n, isR: false, isBid: true, escrow: 1n }]);
    expect(rows[0]).toEqual({ id: 7n, maker: ME, poolId: POOL, units: 5n, price: 9n, expiresAt: 123, isR: false, isBid: true, escrow: 1n });
  });
  it("offer expiry in hours, 0 = none", () => {
    expect(offerExpiry(1000.7, 1)).toBe(4600n);
    expect(offerExpiry(1000, 0)).toBe(0n);
  });
});

describe("trading gates mirror PositionMarket._live", () => {
  const base = { status: Status.Open, expiry: 2_000, windowEnd: 0n, expiryWindowEnd: 0n };
  it("C trades until Closed", () => {
    expect(tradable(base, false, 5_000, 10n)).toBe(true);
    expect(tradable({ ...base, status: Status.Closing }, false, 5_000, 10n)).toBe(true);
    expect(tradable({ ...base, status: Status.Closed }, false, 5_000, 10n)).toBe(false);
    expect(tradable({ ...base, status: Status.None }, false, 5_000, 10n)).toBe(false);
  });
  it("R trades before expiry and until the repayment window ends", () => {
    expect(tradable(base, true, 1_999, 10n)).toBe(true);
    expect(tradable(base, true, 2_000, 10n)).toBe(true); // window of this expiry not started yet
    expect(tradable({ ...base, expiryWindowEnd: 50n }, true, 2_000, 49n)).toBe(true);
    expect(tradable({ ...base, expiryWindowEnd: 50n }, true, 2_000, 50n)).toBe(false);
    expect(tradable({ ...base, status: Status.Window, windowEnd: 50n }, true, 3_000, 49n)).toBe(true);
    expect(tradable({ ...base, status: Status.Window, windowEnd: 50n }, true, 3_000, 50n)).toBe(false);
    expect(tradable({ ...base, status: Status.Closing }, true, 3_000, 10n)).toBe(false);
  });
});

describe("write builders", () => {
  const ctx = (operator: boolean, allowance: boolean): SecondaryCtx => ({
    market: MARKET,
    account: ME,
    ensureOperator: async (spender, label) => (operator ? null : ({ label, address: "0x0000000000000000000000000000000000000c0e", abi: [], functionName: "setOperator", args: [spender, true] } as any)),
    ensureAllowance: async (token, amount, spender) => (allowance ? null : ({ label: "Approve USDC", address: token, abi: [], functionName: "approve", args: [spender, amount] } as any)),
  });
  const bids = [offer(1n, 3000_000000n, E18, { isBid: true }), offer(2n, 2900_000000n, E18, { isBid: true })];

  it("sell now: operator grant first, then one exact hit per bid", async () => {
    const plan = planTakes(bids, (3n * E18) / 2n, 18);
    const w = await sellNowWrites(ctx(false, true), { takes: plan.takes, T: "R" });
    expect(w.map((x) => x.functionName)).toEqual(["setOperator", "hit", "hit"]);
    expect(w[0]!.args).toEqual([MARKET, true]);
    expect(w[1]!.args).toEqual([1n, E18, 3000_000000n]);
    expect(w[2]!.label).toBe("Sell R (2/2)");
    expect((await sellNowWrites(ctx(true, true), { takes: plan.takes.slice(0, 1), T: "C" })).map((x) => x.label)).toEqual(["Sell C"]);
    await expect(sellNowWrites(ctx(true, true), { takes: [], T: "R" })).rejects.toThrow();
  });
  it("list escrows the units with the price and expiry", async () => {
    const w = await listWrites(ctx(true, true), { poolId: POOL, isR: false, units: 5n, price: 7n, expiresAt: 99n });
    expect(w.map((x) => [x.functionName, x.address, x.args])).toEqual([["list", MARKET, [POOL, false, 5n, 7n, 99n]]]);
  });
  it("buy now approves the exact total once, then fills each ask", async () => {
    const asks = [offer(1n, 3n, 1n), offer(2n, 3n, 1n)];
    const plan = planTakes(asks, 2n, 18);
    const w = await buyNowWrites(ctx(true, false), { takes: plan.takes, quote: USDC, T: "C" });
    expect(w.map((x) => x.functionName)).toEqual(["approve", "fill", "fill"]);
    expect(w[0]!.args).toEqual([MARKET, 2n]);
    expect(w[1]!.args).toEqual([1n, 1n, 1n]);
  });
  it("cancel picks the ask or bid entry point", () => {
    expect(cancelWrite(MARKET, { id: 3n, isBid: false }).functionName).toBe("cancel");
    expect(cancelWrite(MARKET, { id: 3n, isBid: true }).functionName).toBe("cancelBid");
  });
});
