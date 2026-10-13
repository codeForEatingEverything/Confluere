import { describe, expect, it } from "vitest";
import { confluereAbi, Status, type Deployment } from "@confluere/sdk";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { Bot, type Io, type Saved } from "../src/bot.js";

const CORE = "0x00000000000000000000000000000000000000c0" as Address;
const USD = "0x0000000000000000000000000000000000000005" as Address;
const ETH = "0x000000000000000000000000000000000000000e" as Address;
const ME = "0x00000000000000000000000000000000000000bb" as Address;
const REG = "0x00000000000000000000000000000000000000ee" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const P1 = `0x${"11".repeat(32)}` as Hex;
const P2 = `0x${"22".repeat(32)}` as Hex;

type Write = { functionName: string; args: readonly unknown[] };

/**
 * Fake core: one Open pool, our bids rest until `settle()` removes them with the given fill cost. `order` honours
 * `blockNumber`, so a bid removed after the block a read is pinned to still shows as resting there.
 */
function world() {
  const s = {
    now: 10_000,
    block: 100n,
    next: 10_060n,
    status: { [P1]: Status.Open, [P2]: Status.Closed } as Record<Hex, Status>,
    orders: new Map<bigint, { pool: Hex; block: bigint; removedAt?: bigint }>(),
    fills: [] as { pool: Hex; id: bigint; quote: bigint; block: bigint }[],
    pending: 0n,
    cBalance: { [P1]: 0n, [P2]: 0n } as Record<Hex, bigint>,
    nextId: 1n,
    writes: [] as Write[],
    calls: [] as string[],
    /** runs right after getBlock answered: lets a test mine blocks between the bot's head read and its other reads */
    afterGetBlock: undefined as (() => void) | undefined,
    /** receipts carry no OrderPlaced log, so the bot cannot track its bid by id */
    hidePlaced: false,
    /** getBlock answers this many blocks behind the chain (a lagging load-balanced RPC backend) */
    headLag: 0n,
  };
  const pub = {
    getBlock: async () => {
      s.calls.push("getBlock");
      const b = { timestamp: BigInt(s.now), number: s.block - s.headLag };
      s.afterGetBlock?.();
      s.afterGetBlock = undefined;
      return b;
    },
    readContract: async ({ functionName: fn, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      s.calls.push(fn);
      const pid = args[0] as Hex;
      switch (fn) {
        case "pool":
          return {
            key: { asset: ETH, quote: USD, expiry: 99_999n, strike: 1n, kind: 0 },
            status: s.status[pid] ?? Status.None,
            assetDecimals: 18,
            lastClearingPrice: 1_000_000n,
          };
        case "nextBatchAt":
          return s.next;
        case "bookHead":
          return [0n, 0];
        case "order": {
          const o = s.orders.get(args[1] as bigint);
          const at = blockNumber ?? s.block;
          const live = o !== undefined && o.block <= at && (o.removedAt === undefined || o.removedAt > at);
          return [live ? ME : ZERO, 1, 0n, 0n, 0n, 0, 0n];
        }
        case "findHint":
          return 0n;
        case "allowance":
          return 2n ** 255n;
        case "pending":
          return s.pending;
        case "seats":
          return [ZERO, 0n, 0n, 0n];
        case "balanceOf":
          return s.cBalance[`0x${(args[1] as bigint).toString(16).padStart(64, "0")}` as Hex] ?? 0n;
      }
      throw new Error(`unmocked ${fn}`);
    },
    getLogs: async ({ args, fromBlock, toBlock }: { args: { poolId: Hex; orderId: bigint }; fromBlock: bigint; toBlock: bigint }) => {
      s.calls.push("getLogs");
      if (toBlock - fromBlock + 1n > 100n) throw new Error("eth_getLogs is limited to a 100 range");
      return s.fills
        .filter((f) => f.pool === args.poolId && f.id === args.orderId && f.block >= fromBlock && f.block <= toBlock)
        .map((f) => ({ args: { quoteAmount: f.quote } }));
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const w = s.writes[Number(hash) - 1]!;
      if (w.functionName !== "placeOrder") return { logs: [], blockNumber: s.block };
      if (s.hidePlaced) return { logs: [], blockNumber: s.block };
      const id = s.nextId++;
      s.orders.set(id, { pool: w.args[0] as Hex, block: s.block });
      const topics = encodeEventTopics({ abi: confluereAbi, eventName: "OrderPlaced", args: { poolId: w.args[0] as Hex, orderId: id, owner: ME } });
      const data = encodeAbiParameters(
        [{ type: "uint8" }, { type: "uint96" }, { type: "uint96" }, { type: "uint128" }, { type: "uint32" }],
        [1, 1n, 1n, 1n, 1],
      );
      return { blockNumber: s.block, logs: [{ address: CORE, topics, data, blockNumber: s.block, logIndex: 0, transactionIndex: 0, transactionHash: hash, blockHash: hash, removed: false }] };
    },
  };
  const wallet = {
    chain: undefined,
    writeContract: async (w: Write) => {
      s.writes.push(w);
      if (w.functionName === "withdraw") s.pending = 0n;
      if (w.functionName === "claim") s.cBalance[w.args[0] as Hex] = 0n;
      return `0x${s.writes.length.toString(16)}` as Hex;
    },
  };
  const io = { pub, wallet, account: { address: ME }, d: { confluere: CORE, seatRegistry: REG } as Deployment, chainId: 10143 } as unknown as Io;
  /** settle the batch: every resting bid of ours is removed; `paid` is what its fill cost (0 = unfilled, refunded) */
  const settle = (paid: bigint, refund: bigint) => {
    s.block += 250n; // more than Monad's 100-block getLogs cap: the bot must page
    for (const [id, o] of s.orders) {
      if (o.removedAt !== undefined) continue;
      if (paid > 0n) s.fills.push({ pool: o.pool, id, quote: paid, block: s.block });
      o.removedAt = s.block;
    }
    s.pending += refund;
    s.now += 120;
    s.next += 120n;
    s.block += 10n;
  };
  return { s, io, settle };
}

const cfg = { pools: [{ id: P1, cls: "main" as const }], perBatch: 1_000_000_000n, total: 2_000_000_000n, endAt: 0, leadS: 90 };
const bids = (w: Write[]) => w.filter((x) => x.functionName === "placeOrder").length;

describe("bootstrap bot accounting", () => {
  it("unfilled bids do not use up the total cap: it keeps quoting long past TOTAL / PER_BATCH batches", async () => {
    const { s, io, settle } = world();
    const state: Saved = { spent: {} };
    const bot = new Bot(io, cfg, state, () => {}, () => {});
    for (let i = 0; i < 6; i++) {
      await bot.tick();
      settle(0n, 1_000_000_000n);
    }
    expect(bids(s.writes)).toBe(6);
    expect(state.spent[P1] ?? "0").toBe("0");
  });

  it("counts what fills actually paid, read from OrderFilled across paged log ranges", async () => {
    const { io, settle } = world();
    const state: Saved = { spent: {} };
    const bot = new Bot(io, cfg, state, () => {}, () => {});
    await bot.tick();
    expect(bot.remaining(P1)).toBeLessThan(cfg.total); // the resting bid's escrow is reserved
    settle(300_000_000n, 0n);
    await bot.tick();
    expect(state.spent[P1]).toBe("300000000");
  });

  it("does not lose a fill mined between the head read and the order read", async () => {
    const { s, io } = world();
    const state: Saved = { spent: {} };
    const bot = new Bot(io, cfg, state, () => {}, () => {});
    await bot.tick(); // our bid (order 1) rests from block 100
    // settleBatch lands one block after the bot read the head: the order is gone at latest, its fill log is at head + 1
    s.afterGetBlock = () => {
      s.block += 1n;
      s.fills.push({ pool: P1, id: 1n, quote: 400_000_000n, block: s.block });
      s.orders.get(1n)!.removedAt = s.block;
    };
    await bot.tick();
    expect(state.open?.[P1]?.map((o) => o.id)).toEqual(["1"]); // still resting at head: judged next tick
    expect(state.spent[P1] ?? "0").toBe("0");
    s.block += 1n;
    await bot.tick();
    expect(state.spent[P1]).toBe("400000000");
    expect(state.open?.[P1]).toBeUndefined();
  });

  it("keeps a bid placed after a lagging head and counts its fill once it lands", async () => {
    const { s, io, settle } = world();
    const state: Saved = { spent: {} };
    const bot = new Bot(io, cfg, state, () => {}, () => {});
    await bot.tick(); // our bid (order 1) rests from block 100
    s.headLag = 5n; // next getBlock answers block 95, before the bid existed
    await bot.tick();
    expect(state.open?.[P1]?.map((o) => o.id)).toEqual(["1"]);
    expect(bot.remaining(P1)).toBeLessThan(cfg.total); // its escrow is still reserved
    s.headLag = 0n;
    settle(300_000_000n, 0n);
    await bot.tick();
    expect(state.spent[P1]).toBe("300000000");
    expect(state.open?.[P1]?.map((o) => o.id)).toEqual(["2"]); // order 1 settled; order 2 is the next batch's bid
  });

  it("reads each pool once per tick and polls pending only when a refund can have arrived", async () => {
    const { s, io, settle } = world();
    const state: Saved = { spent: {} };
    const bot = new Bot(io, cfg, state, () => {}, () => {});
    await bot.tick(); // first tick: pending checked once (refunds while down), bid placed
    expect(s.calls.filter((c) => c === "pool")).toHaveLength(1);
    expect(s.calls.filter((c) => c === "pending")).toHaveLength(1);
    s.calls = [];
    await bot.tick(); // same batch, bid still resting
    expect(s.calls).toEqual(["getBlock", "order", "pool", "seats", "nextBatchAt"]);
    settle(0n, 1_000_000_000n);
    s.calls = [];
    await bot.tick(); // our bid left the book: its refund is withdrawn
    expect(s.calls.filter((c) => c === "pool")).toHaveLength(1);
    expect(s.calls.filter((c) => c === "pending")).toHaveLength(1);
    expect(s.writes.filter((w) => w.functionName === "withdraw")).toHaveLength(1);
  });

  it("an untracked bid counts its whole escrow and its refund is still withdrawn at the next batch", async () => {
    const { s, io, settle } = world();
    s.hidePlaced = true;
    const state: Saved = { spent: {} };
    const bot = new Bot(io, cfg, state, () => {}, () => {});
    await bot.tick();
    expect(BigInt(state.spent[P1]!)).toBeGreaterThan(0n);
    settle(0n, 1_000_000_000n);
    await bot.tick();
    expect(s.writes.filter((w) => w.functionName === "withdraw")).toHaveLength(1);
  });

  it("after a restart, and after exit, an untracked bid's refund is still withdrawn", async () => {
    const { s, io, settle } = world();
    s.hidePlaced = true;
    const state: Saved = { spent: {} };
    await new Bot(io, cfg, state, () => {}, () => {}).tick();
    expect(state.untracked).toBe(true);
    state.exited = "END_AT reached";
    const restarted = new Bot(io, cfg, state, () => {}, () => {});
    await restarted.tick(); // the start-up withdraw check finds nothing yet
    expect(s.writes.filter((w) => w.functionName === "withdraw")).toHaveLength(0);
    settle(0n, 1_000_000_000n);
    await restarted.tick();
    expect(s.writes.filter((w) => w.functionName === "withdraw")).toHaveLength(1);
  });

  it("withdraws refunds and claims closed pools once, also after it stopped quoting", async () => {
    const { s, io } = world();
    s.pending = 42n;
    s.cBalance[P2] = 5n;
    const state: Saved = { spent: { [P2]: "7" }, exited: "END_AT reached" };
    const bot = new Bot(io, cfg, state, () => {}, () => {});
    await bot.tick();
    expect(s.writes.map((w) => [w.functionName, w.args])).toEqual([
      ["claim", [P2]],
      ["withdraw", [USD, ME]],
    ]);
    expect(state.claimed).toEqual([P2]);
    await bot.tick();
    expect(s.writes).toHaveLength(2);
  });
});
