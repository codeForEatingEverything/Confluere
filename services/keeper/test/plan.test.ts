import { describe, expect, it } from "vitest";
import { Side, Status } from "@confluere/sdk";
import { worthSettling, deadOrders, dueAction, missedBatchEnd, pokeDue, rolloverDead, rolloverRecheck, type OldPool, type PoolSnapshot } from "../src/plan.js";

const base: PoolSnapshot = { status: Status.Open, expiry: 10_000, windowEnd: 0n, pausedUntil: 0n, nextBatchAt: 1800 };

describe("dueAction", () => {
  it("settles after the boundary plus delay", () => {
    expect(dueAction(base, 1804, 1n, 5)).toBe("none");
    expect(dueAction(base, 1805, 1n, 5)).toBe("settle");
  });
  it("does not settle a batch that starts at or after expiry", () => {
    expect(dueAction({ ...base, nextBatchAt: 10_000 }, 9_999, 1n, 0)).toBe("none");
  });
  it("matures at expiry", () => {
    expect(dueAction(base, 10_000, 1n, 5)).toBe("mature");
  });
  it("waits while paused", () => {
    expect(dueAction({ ...base, pausedUntil: 50n }, 1900, 10n, 5)).toBe("none");
  });
  it("closes once the window ends, and keeps closing while Closing", () => {
    expect(dueAction({ ...base, status: Status.Window, windowEnd: 100n }, 0, 99n, 5)).toBe("none");
    expect(dueAction({ ...base, status: Status.Window, windowEnd: 100n }, 0, 100n, 5)).toBe("close");
    expect(dueAction({ ...base, status: Status.Closing }, 0, 0n, 5)).toBe("close");
    expect(dueAction({ ...base, status: Status.Selling }, 0, 0n, 5)).toBe("close");
    expect(dueAction({ ...base, status: Status.Closed }, 0, 0n, 5)).toBe("none");
  });
});

describe("pokeDue", () => {
  it("fires once in the lead window before each boundary", () => {
    expect(pokeDue(1700, 0, 1800, -1, 60)).toBe(false);
    expect(pokeDue(1750, 0, 1800, -1, 60)).toBe(true);
    expect(pokeDue(1750, 0, 1800, 0, 60)).toBe(false);
    expect(pokeDue(3550, 0, 1800, 0, 60)).toBe(true);
  });
});

describe("missedBatchEnd (mirrors SeatRegistry.slash)", () => {
  it("mainstream pool: two consecutive base batches after the last quote (v0.8)", () => {
    // quoted in base batch 10 (interval 1800): missed batches 11 and 12, the second ends at 13*1800
    expect(missedBatchEnd(0, 1800, 10, 1800)).toBe(13 * 1800);
  });
  it("6 h long-tail pool: the first two full 6 h batches after the quote", () => {
    // quote ends at 11*1800 = 19800; next 6 h boundary is 21600; two missed batches end at 64800
    expect(missedBatchEnd(0, 1800, 10, 21600)).toBe(64800);
  });
});

describe("deadOrders", () => {
  const book = [
    { id: 1n, side: Side.Sell, deadline: 3 },
    { id: 2n, side: Side.Buy, deadline: 9 },
    { id: 3n, side: Side.NcBuy, deadline: 5 },
    { id: 4n, side: Side.Bid, deadline: 0 },
  ];
  it("while trading: only orders whose ttl is spent", () => {
    expect(deadOrders(book, 5, false)).toEqual([1n, 3n]);
  });
  it("after trading stops: every order except bids", () => {
    expect(deadOrders(book, 0, true)).toEqual([1n, 2n, 3n]);
  });
});

describe("rollover orders (mirrors OrderLogic.purge)", () => {
  const old: OldPool = { status: Status.Open, expiry: 1_000, windowEnd: 0n, expiryWindowEnd: 0n };
  it("alive while the old pool trades, after its expiry until the window ends, and during its window", () => {
    expect(rolloverDead(old, 999, 1n)).toBe(false);
    expect(rolloverDead(old, 1_000, 1n)).toBe(false); // expired, nobody matured yet: window pending
    expect(rolloverDead({ ...old, expiryWindowEnd: 50n }, 1_000, 49n)).toBe(false);
    expect(rolloverDead({ ...old, status: Status.Window, windowEnd: 50n }, 1_000, 49n)).toBe(false);
  });
  it("dead once the old window ended or the old pool closed", () => {
    expect(rolloverDead({ ...old, expiryWindowEnd: 50n }, 1_000, 50n)).toBe(true);
    expect(rolloverDead({ ...old, status: Status.Window, windowEnd: 50n }, 1_000, 50n)).toBe(true);
    expect(rolloverDead({ ...old, status: Status.Closing }, 1_000, 1n)).toBe(true);
    expect(rolloverDead({ ...old, status: Status.Closed }, 1_000, 1n)).toBe(true);
  });
  it("tells the keeper when to look again", () => {
    expect(rolloverRecheck(old, 999, 1n)).toEqual({ time: 1_000 });
    expect(rolloverRecheck({ ...old, status: Status.Window, windowEnd: 50n }, 1_000, 1n)).toEqual({ block: 50n });
    expect(rolloverRecheck({ ...old, expiryWindowEnd: 70n }, 1_000, 1n)).toEqual({ block: 70n });
    expect(rolloverRecheck(old, 1_000, 5n)).toEqual({ block: 6n });
  });
  it("deadOrders includes rollover orders flagged dead while trading", () => {
    const book = [
      { id: 1n, side: Side.Sell, deadline: 9, rolloverDead: true },
      { id: 2n, side: Side.Sell, deadline: 9, rolloverDead: false },
    ];
    expect(deadOrders(book, 5, false)).toEqual([1n]);
  });
});

describe("worthSettling", () => {
  it("skips only a completely empty book", () => {
    expect(worthSettling(0, 0, 0, 0)).toBe(false);
  });
  it("settles a one-sided book: ttl must advance and long-tail cancels unlock", () => {
    expect(worthSettling(3, 0, 0, 0)).toBe(true);
    expect(worthSettling(0, 2, 0, 0)).toBe(true);
    expect(worthSettling(0, 0, 1, 0)).toBe(true);
    expect(worthSettling(0, 0, 0, 1)).toBe(true);
    expect(worthSettling(1, 1, 0, 0)).toBe(true);
  });
});
