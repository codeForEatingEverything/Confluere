/** Server event index: decoding, idempotent replays, order candidates, seeded ids, disk cache round trip. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { deployments } from "@confluere/sdk";
import { EVENTS, _resetIndexes, applyLogs, batchesOf, getIndex, logSources, ordersOf, poolsOf, quoteKeysOf, servesChain, statusOf } from "../src/lib/server/chainIndex";
import type { RawLog, Rpc } from "../src/lib/server/logScan";

const dir = mkdtempSync(join(tmpdir(), "cf-index-"));
process.env.CONFLUERE_INDEX_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const P1 = `0x${"a1".repeat(32)}` as Hex;
const P2 = `0x${"b2".repeat(32)}` as Hex;
const OWNER = "0x00000000000000000000000000000000000000e1" as const;
const ASSET = "0x5555555555555555555555555555555555555555" as const;
const USDC = "0x2B3370eE501B4a559b57D449569354196457D8Ab" as const;

let li = 0;
function log(eventName: string, args: Record<string, unknown>, block: number): RawLog {
  const ev = EVENTS.find((e) => e.name === eventName)!;
  const topics = encodeEventTopics({ abi: [ev], eventName, args } as never) as Hex[];
  const plain = (ev.inputs as readonly { name?: string; indexed?: boolean }[]).filter((x) => !x.indexed);
  const data = encodeAbiParameters(plain as never, plain.map((x) => args[x.name!]) as never);
  return { address: "0x00", topics, data, blockNumber: `0x${block.toString(16)}`, logIndex: `0x${(li++).toString(16)}`, transactionHash: "0x00" };
}

const created = (id: Hex, block: number, strike = 34_000000n) =>
  log("PoolCreated", { poolId: id, key: { asset: ASSET, quote: USDC, expiry: 1791810000n, strike, kind: 0 }, feeBps: 1000, bandBps: 800, marketId: `0x${"cc".repeat(32)}` }, block);

const empty = () => ({ pools: new Map(), batches: new Map(), orders: new Map(), removed: new Set<string>(), quotes: new Set<string>() });

describe("applyLogs", () => {
  it("decodes every event kind and is idempotent", () => {
    const ix = empty();
    const logs = [
      created(P1, 100),
      log("BatchSettled", { poolId: P1, settleIndex: 1, price: 32_810000n, competitiveUnits: 5n, ncUnits: 2n }, 110),
      log("BatchSettled", { poolId: P1, settleIndex: 2, price: 33_000000n, competitiveUnits: 1n, ncUnits: 0n }, 120),
      log("OrderPlaced", { poolId: P1, orderId: 7n, owner: OWNER, side: 0, units: 10n, limit: 1n, escrow: 10n, deadline: 4 }, 105),
      log("OrderPlaced", { poolId: P1, orderId: 8n, owner: OWNER, side: 1, units: 10n, limit: 1n, escrow: 10n, deadline: 4 }, 106),
      log("OrderRemoved", { poolId: P1, orderId: 7n, reason: 1 }, 111),
      log("Quoted", { market: `0x${"cc".repeat(32)}`, poolId: P1, orderId: 8n, batch: 3n }, 106),
    ];
    applyLogs(ix, logs);
    applyLogs(ix, logs); // a chunk read twice after a failed scan
    expect([...ix.pools.values()]).toHaveLength(1);
    const p = ix.pools.get(P1.toLowerCase());
    expect(p).toMatchObject({ id: P1, block: 100, strike: "34000000", kind: 0, feeBps: 1000, bandBps: 800 });
    expect([...ix.batches.get(P1.toLowerCase())!.values()].map((b) => [b.index, b.price, b.units, b.nc])).toEqual([
      [1, "32810000", "7", "2"],
      [2, "33000000", "1", "0"],
    ]);
    expect(ordersOf(ix as never, OWNER).map((o) => o.id)).toEqual(["8"]);
    expect(ordersOf(ix as never, OWNER.toUpperCase().replace("0X", "0x"))).toHaveLength(1);
    expect(quoteKeysOf(ix as never)).toEqual([`${P1.toLowerCase()}:8`]);
    expect(batchesOf(ix as never, P1).map((b) => b.index)).toEqual([2, 1]);
  });

  it("skips logs it cannot decode", () => {
    const ix = empty();
    applyLogs(ix, [{ address: "0x00", topics: [`0x${"00".repeat(32)}`], data: "0x", blockNumber: "0x1", logIndex: "0x0", transactionHash: "0x00" }]);
    expect(ix.pools.size).toBe(0);
  });
});

describe("getIndex", () => {
  const chain = 998;
  const d = deployments[chain]!;
  const head = d.deployBlock + 2500;
  const rpcFor = (logs: RawLog[]): Rpc => async (_url, method, params) => {
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    const f = params[0] as { fromBlock: string; toBlock: string };
    return logs.filter((l) => Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock));
  };

  beforeEach(() => {
    _resetIndexes();
    rmSync(join(dir, `${chain}.json`), { force: true });
  });

  it("serves the seeded ids at once, then the scanned pools with their creation blocks", async () => {
    expect(servesChain(chain)).toBe(true);
    const rpc = rpcFor([created(P2, d.deployBlock + 2000, 35_000000n)]);
    const cold = await getIndex(chain, 0, rpc);
    expect(poolsOf(cold).map((p) => p.id)).toEqual(d.pools!.poolIds); // seeds, before any scan finished
    expect(statusOf(cold).complete).toBe(false);
    const warm = await getIndex(chain, 2_000, rpc);
    expect(statusOf(warm).complete).toBe(true);
    expect(statusOf(warm).scannedTo).toBe(head - 2); // stays two blocks behind the head
    const found = poolsOf(warm).find((p) => p.id === P2);
    expect(found?.block).toBe(d.deployBlock + 2000);
    // seeds the scan has not reached stay listed (block null), after the dated ones
    expect(poolsOf(warm).at(-1)?.block).toBeNull();
  });

  it("writes a disk cache that a fresh process loads warm", async () => {
    const rpc = rpcFor([created(P2, d.deployBlock + 10)]);
    await getIndex(chain, 2_000, rpc);
    await new Promise((r) => setTimeout(r, 50)); // the write is async
    _resetIndexes();
    const never: Rpc = () => new Promise(() => {}); // no RPC answers: everything must come from the cache
    const ix = await getIndex(chain, 0, never);
    expect(statusOf(ix).complete).toBe(true);
    expect(poolsOf(ix).some((p) => p.id === P2)).toBe(true);
  });

  it("records the error and keeps serving what it has when every RPC fails", async () => {
    const down: Rpc = async () => {
      throw new Error("HTTP 503");
    };
    const ix = await getIndex(chain, 3_000, down);
    expect(statusOf(ix).error).toMatch(/503/);
    expect(poolsOf(ix).length).toBe(d.pools!.poolIds.length);
  });
});

describe("logSources", () => {
  it("Monad prefers wide public endpoints and ends with the official 100-block RPC", () => {
    const s = logSources(10143);
    expect(s[0]!.range).toBeGreaterThanOrEqual(1000);
    expect(s.at(-1)).toMatchObject({ url: "https://testnet-rpc.monad.xyz", range: 100 });
  });

  it("HyperEVM reads through Chainlink in 1,000-block ranges, the official RPC as fallback", () => {
    const s = logSources(998);
    expect(s[0]).toMatchObject({ url: "https://rpcs.chain.link/hyperevm/testnet", range: 1000 });
    expect(s.some((x) => x.url.includes("hyperliquid-testnet"))).toBe(true);
  });

  it("LOGS_RPC_<id> overrides the list", () => {
    process.env.LOGS_RPC_998 = "https://x.example|500|3,https://y.example|50";
    expect(logSources(998)).toEqual([
      { url: "https://x.example", range: 500, concurrency: 3 },
      { url: "https://y.example", range: 50, concurrency: 2 },
    ]);
    delete process.env.LOGS_RPC_998;
  });

  it("does not serve chains that are not enabled", () => {
    expect(servesChain(1)).toBe(false);
    expect(servesChain(31337)).toBe(false); // anvil only with NEXT_PUBLIC_ENABLE_ANVIL=1
  });
});
