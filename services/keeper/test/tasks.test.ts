import { describe, expect, it } from "vitest";
import { Side, Status, marketId } from "@confluere/sdk";
import type { Address, Hex } from "viem";
import { Tasks } from "../src/tasks.js";
import { tick, type Scanner } from "../src/tick.js";
import { deployment, mockChain, type MockPool, type MockVault } from "./mock.js";

const A = "0x000000000000000000000000000000000000000a" as Address;
const B = "0x000000000000000000000000000000000000000b" as Address;
const USD = "0x0000000000000000000000000000000000000005" as Address;
const pid = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const V1 = "0x0000000000000000000000000000000000000071" as Address;
const V2 = "0x0000000000000000000000000000000000000072" as Address;

// past gridAnchor + 4 periods so graduation runs; batch 166 spans [19920, 20040)
const NOW = 20_000;
const opts = { settleDelayS: 5, pokeLeadS: 0, closeMaxBids: 16n };
const quiet = () => {};

function open(asset: Address, extra: Partial<MockPool> = {}): MockPool {
  return { asset, quote: USD, kind: 0, status: Status.Open, expiry: NOW + 36_000, settleCount: 3, nextBatchAt: NOW + 40, ...extra };
}

function setup(pools: Record<Hex, MockPool>, vaults: Record<Address, MockVault> = {}, more: Partial<Parameters<typeof mockChain>[0]> = {}) {
  return setupWith(opts, pools, vaults, more);
}

function setupWith(o: typeof opts, pools: Record<Hex, MockPool>, vaults: Record<Address, MockVault> = {}, more: Partial<Parameters<typeof mockChain>[0]> = {}) {
  const state = { pools, vaults, now: NOW, block: 1_000n, ...more };
  const { c, calls } = mockChain(state);
  const tasks = new Tasks(c, deployment, o, quiet);
  const disc: Scanner = { pools: new Set(Object.keys(pools) as Hex[]), vaults: new Set(Object.keys(vaults) as Address[]), scan: async () => {} };
  return { state, c, calls, tasks, disc, run: () => tick(c, disc, tasks, quiet) };
}

const idle: MockVault = { targetExpiry: BigInt(NOW + 3_600), pendingDepositAssets: 0n, pendingRedeemShares: 0n };
const fns = (calls: { fn?: string }[]) => calls.map((c) => c.fn).filter(Boolean);

const TWO_SIDED = { [Side.Sell]: [{ id: 1n, deadline: 50 }], [Side.Buy]: [{ id: 2n, deadline: 50 }] };

describe("keeper RPC budget", () => {
  it("bounds calls per tick and runs graduation, seats and vault checks once per batch", async () => {
    const s = setup({ [pid(1)]: open(A), [pid(2)]: open(A), [pid(3)]: open(B), [pid(4)]: open(B) }, { [V1]: idle, [V2]: idle }, {
      graduated: new Set([marketId(A, USD, 0)]),
    });

    await s.run();
    // getBlock + 2 reads per pool + 4 book heads per pool (first walk) + graduation (A: 1 read; B: read + simulate)
    // + 1 seat read per market + 3 reads per vault (no roll simulated: target in the future, nothing pending)
    expect(s.calls.length).toBe(1 + 8 + 16 + 3 + 2 + 6);
    expect(fns(s.calls)).not.toContain("roll");

    // same batch, 15 s later: only the per-pool snapshot
    s.calls.length = 0;
    s.state.now = NOW + 15;
    s.state.block += 15n;
    await s.run();
    expect(s.calls.length).toBe(1 + 8);
    expect(fns(s.calls).every((f) => f === "pool" || f === "nextBatchAt")).toBe(true);

    // next batch: market A was graduated by someone else and is never asked again; B is retried once
    s.calls.length = 0;
    s.state.now = NOW + 50;
    await s.run();
    const grad = s.calls.filter((c) => c.fn === "graduated" || c.fn === "graduate");
    expect(grad.map((c) => c.fn)).toEqual(["graduated", "graduate"]);
    expect(grad[0]!.args).toEqual([marketId(B, USD, 0)]);
    expect(fns(s.calls).filter((f) => f === "seats")).toHaveLength(2);
  });

  it("a failing pool read does not skip the other pools or the non-pool tasks", async () => {
    const s = setup({ [pid(1)]: open(A), [pid(2)]: open(A), [pid(3)]: open(B, { nextBatchAt: NOW - 10, book: TWO_SIDED }) }, {}, {
      passes: new Set(["settleBatch"]),
      failing: (c) => c.fn === "pool" && c.args?.[0] === pid(2),
    });
    s.disc.scan = async () => {
      throw new Error("eth_getLogs is limited to a 100 range");
    };
    await s.run();
    const writes = s.calls.filter((c) => c.method === "write");
    expect(writes.map((w) => [w.fn, w.args?.[0]])).toEqual([["settleBatch", pid(3)]]);
    expect(fns(s.calls)).toContain("graduated");
  });
});

describe("keeper vault poke", () => {
  const lead = { ...opts, pokeLeadS: 3_600 };
  it("pokes only a vault with idle funds and a graduated target pool", async () => {
    const run = async (v: MockVault) => {
      const s = setupWith(lead, {}, { [V1]: v }, { passes: new Set(["poke"]) });
      await s.run();
      return s.calls.filter((c) => c.method === "simulate" && c.fn === "poke").length;
    };
    expect(await run({ ...idle, investable: 0n })).toBe(0);
    expect(await run({ ...idle, investable: 5n, assets: [A] })).toBe(0); // no graduated target
    expect(await run({ ...idle, investable: 5n, assets: [A], targetPool: pid(1) })).toBe(1);
  });
});

describe("keeper settle", () => {
  const settles = (calls: { method: string; fn?: string; args?: readonly unknown[] }[]) =>
    calls.filter((c) => c.method === "write" && c.fn === "settleBatch").map((c) => c.args?.[0]);

  it("settles a due batch with a one-sided book, so ttl advances and long-tail cancels unlock", async () => {
    const s = setup(
      {
        [pid(1)]: open(A, { nextBatchAt: NOW - 10, book: { [Side.Sell]: [{ id: 1n, deadline: 50 }] } }),
        [pid(2)]: open(A, { nextBatchAt: NOW - 10, book: { [Side.NcBuy]: [{ id: 2n, deadline: 4 }] } }),
      },
      {},
      { passes: new Set(["settleBatch"]) },
    );
    await s.run();
    expect(settles(s.calls)).toEqual([pid(1), pid(2)]);
  });

  it("skips a completely empty book and does not re-read it every tick while it stays due", async () => {
    const s = setup({ [pid(1)]: open(A, { nextBatchAt: NOW - 10 }) }, {}, { passes: new Set(["settleBatch"]) });
    await s.run();
    expect(settles(s.calls)).toEqual([]);
    expect(fns(s.calls).filter((f) => f === "bookHead")).toHaveLength(4);

    // same base batch, same nextBatchAt: only the snapshot (pool + nextBatchAt)
    s.calls.length = 0;
    s.state.now = NOW + 15;
    await s.run();
    expect(s.calls.filter((c) => c.args?.[0] === pid(1)).map((c) => c.fn)).toEqual(["pool", "nextBatchAt"]);

    // next base batch: read once more (fallback in case an order arrived unseen)
    s.calls.length = 0;
    s.state.now = NOW + 50;
    await s.run();
    expect(fns(s.calls).filter((f) => f === "bookHead")).toHaveLength(4);
    expect(settles(s.calls)).toEqual([]);
  });

  it("re-reads a cached empty book in the same batch once the pool gets a new order, and settles it", async () => {
    const s = setup({ [pid(1)]: open(A, { nextBatchAt: NOW - 10 }) }, {}, { passes: new Set(["settleBatch"]) });
    s.disc.touched = new Set();
    await s.run();
    expect(settles(s.calls)).toEqual([]);

    s.state.pools[pid(1)]!.book = { [Side.Buy]: [{ id: 3n, deadline: 50 }] };
    s.disc.scan = async () => {
      s.disc.touched!.add(pid(1));
    };
    s.state.now = NOW + 15;
    await s.run();
    expect(settles(s.calls)).toEqual([pid(1)]);
    expect(s.disc.touched.size).toBe(0);
  });

  it("SETTLE_EMPTY settles an empty book without reading it", async () => {
    const state = { pools: { [pid(1)]: open(A, { nextBatchAt: NOW - 10 }) }, now: NOW, block: 1_000n, passes: new Set(["settleBatch"]) };
    const { c, calls } = mockChain(state);
    const tasks = new Tasks(c, deployment, { ...opts, settleEmpty: true }, quiet);
    await tasks.runPools([pid(1)], NOW, 1_000n);
    expect(fns(calls)).not.toContain("bookHead");
    expect(settles(calls)).toEqual([pid(1)]);
  });
});

describe("keeper closed pools", () => {
  it("a Closed pool costs no reads once its book was walked and purged", async () => {
    const s = setup({ [pid(1)]: open(A, { status: Status.Closed, book: { [Side.Buy]: [{ id: 9n, deadline: 99 }] } }) }, {}, {
      passes: new Set(["purge"]),
    });
    await s.run();
    expect(s.calls.filter((c) => c.method === "write").map((c) => c.args)).toEqual([[pid(1), [9n]]]);
    s.calls.length = 0;
    s.state.now = NOW + 15;
    await s.run();
    expect(s.calls.filter((c) => c.args?.[0] === pid(1))).toHaveLength(0);
  });

  it("keeps reading a Closed pool whose purge failed until it succeeds", async () => {
    let failures = 1;
    const s = setup({ [pid(1)]: open(A, { status: Status.Closed, book: { [Side.Buy]: [{ id: 9n, deadline: 99 }] } }) }, {}, {
      passes: new Set(["purge"]),
      failing: (c) => c.method === "simulate" && c.fn === "purge" && failures-- > 0,
    });
    await s.run();
    s.calls.length = 0;
    s.state.now = NOW + 15;
    await s.run();
    expect(fns(s.calls)).toContain("pool");
    expect(s.calls.filter((c) => c.method === "write").map((c) => c.args)).toEqual([[pid(1), [9n]]]);
  });
});

describe("keeper seat fee split", () => {
  const MA = marketId(A, USD, 0);
  const HOLDER = "0x00000000000000000000000000000000000000dd" as Address;
  // quoted in the current base batch: no missed batch, so slash never fires in these tests
  const seated = { [MA]: { holder: HOLDER, lastQuoted: 10_000 } };
  const splits = (calls: { method: string; fn?: string; args?: readonly unknown[] }[]) =>
    calls.filter((c) => c.method === "write" && c.fn === "split").map((c) => c.args);

  it("splits once per batch for a held market, only when marketFees grew", async () => {
    const s = setup({ [pid(1)]: open(A) }, {}, {
      passes: new Set(["split"]),
      seats: seated,
      marketFees: { [MA]: 100n },
      feesSplit: { [MA]: 40n },
    });
    await s.run();
    expect(splits(s.calls)).toEqual([[A, USD, 0]]);
    s.state.feesSplit![MA] = 100n;

    // same batch: not checked again
    s.calls.length = 0;
    s.state.now = NOW + 15;
    await s.run();
    expect(fns(s.calls)).not.toContain("marketFees");

    // next batch, nothing new: one read, no registry read, no transaction
    s.calls.length = 0;
    s.state.now = NOW + 50;
    await s.run();
    expect(fns(s.calls).filter((f) => f === "marketFees" || f === "feesSplit" || f === "split")).toEqual(["marketFees"]);

    // fees grew: split again
    s.calls.length = 0;
    s.state.marketFees![MA] = 130n;
    s.state.now = NOW + 170;
    await s.run();
    expect(splits(s.calls)).toEqual([[A, USD, 0]]);
  });

  it("does not pay for a split somebody else already made", async () => {
    const s = setup({ [pid(1)]: open(A) }, {}, {
      passes: new Set(["split"]),
      seats: seated,
      marketFees: { [MA]: 100n },
      feesSplit: { [MA]: 100n },
    });
    await s.run();
    expect(fns(s.calls)).not.toContain("split");
  });

  it("leaves markets without a seat holder alone", async () => {
    const s = setup({ [pid(1)]: open(A) }, {}, { passes: new Set(["split"]), marketFees: { [MA]: 100n } });
    await s.run();
    expect(fns(s.calls)).not.toContain("marketFees");
    expect(fns(s.calls)).not.toContain("split");
  });
});

describe("keeper purge", () => {
  const OLD = pid(9);

  it("purges a rollover sell once its old pool's window ends, even if the new pool did not settle since", async () => {
    const s = setup(
      {
        [pid(1)]: open(A, { settleCount: 5, book: { [Side.Sell]: [{ id: 7n, deadline: 50, rolloverSource: OLD }, { id: 8n, deadline: 50 }] } }),
        [OLD]: open(A, { status: Status.Window, expiry: NOW - 600, windowEnd: 1_010n }),
      },
      {},
      { passes: new Set(["purge"]) },
    );
    await s.run();
    expect(s.calls.filter((c) => c.fn === "purge")).toHaveLength(0);

    s.state.now = NOW + 5;
    s.state.block = 1_010n; // old window over; new pool's settle count unchanged
    await s.run();
    const w = s.calls.filter((c) => c.method === "write" && c.fn === "purge");
    expect(w.map((c) => c.args)).toEqual([[pid(1), [7n]]]);
  });

  it("retries a purge that failed instead of marking the pool done", async () => {
    let failures = 1;
    const s = setup({ [pid(1)]: open(A, { status: Status.Closed, book: { [Side.Buy]: [{ id: 9n, deadline: 99 }] } }) }, {}, {
      passes: new Set(["purge"]),
      failing: (c) => c.method === "simulate" && c.fn === "purge" && failures-- > 0,
    });
    await s.run();
    expect(s.calls.filter((c) => c.method === "write")).toHaveLength(0);
    s.state.now = NOW + 5;
    await s.run();
    expect(s.calls.filter((c) => c.method === "write").map((c) => c.args)).toEqual([[pid(1), [9n]]]);
    // done now: a Closed pool's book is not walked again
    s.calls.length = 0;
    s.state.now = NOW + 10;
    await s.run();
    expect(fns(s.calls)).not.toContain("bookHead");
  });
});

describe("keeper vault roll", () => {
  it("simulates roll only when Vault.roll could pass, and re-checks right after a pool closes", async () => {
    const vault = { ...idle };
    const s = setup({ [pid(1)]: open(A) }, { [V1]: vault }, { passes: new Set(["roll"]) });
    await s.run();
    expect(fns(s.calls)).not.toContain("roll");

    // a pool closes later in the same batch: the vault is checked again without waiting for the next batch
    vault.pendingDepositAssets = 5n;
    s.state.pools[pid(1)]!.status = Status.Closed;
    s.state.now = NOW + 15;
    await s.run();
    expect(s.calls.filter((c) => c.method === "write").map((c) => c.fn)).toContain("roll");
  });
});
