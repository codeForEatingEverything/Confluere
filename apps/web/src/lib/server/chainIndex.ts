/**
 * Per-chain event index kept in server memory (one per Next server process, shared across requests and surviving
 * dev hot reloads through globalThis). A single log scan per chain reads the core and the seat registry for:
 * PoolCreated (pool discovery), BatchSettled (clearing-price history), OrderPlaced / OrderRemoved (an account's
 * open-order candidates) and SeatRegistry Quoted (seat obligation orders, which cannot be cancelled early).
 *
 * The first request on a cold process starts the backfill from the deploy block and answers within its wait budget
 * with whatever is known (always at least the deployment's seeded pool ids) plus `complete: false`; later requests
 * only scan the new blocks, at most once per REFRESH_MS. Every handler is idempotent, so a chunk read twice after a
 * failed scan changes nothing. The index is also written to .next/cache/confluere-index/<chainId>.json (override the
 * folder with CONFLUERE_INDEX_DIR) at most every 10 s, so a restarted server starts warm; `pnpm clean` removes it.
 */
import { after } from "next/server";
import { mkdir, readFileSync, writeFile } from "./fsCompat";
import { join } from "node:path";
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import { logRange, marketId as toMarketId } from "@confluere/sdk";
import { CHAINLINK_HYPER_TESTNET_RPC, deploymentOf, isEnabledChain, rpcUrlsOf } from "../chains";
import { fetchRpc, headOf, scanLogs, type LogSource, type RawLog, type Rpc } from "./logScan";

export const EVENTS = parseAbi([
  "event PoolCreated(bytes32 indexed poolId, (address asset, address quote, uint64 expiry, uint128 strike, uint8 kind) key, uint16 feeBps, uint16 bandBps, bytes32 indexed marketId)",
  "event BatchSettled(bytes32 indexed poolId, uint32 indexed settleIndex, uint256 price, uint256 competitiveUnits, uint256 ncUnits)",
  "event OrderPlaced(bytes32 indexed poolId, uint64 indexed orderId, address indexed owner, uint8 side, uint96 units, uint96 limit, uint128 escrow, uint32 deadline)",
  "event OrderRemoved(bytes32 indexed poolId, uint64 indexed orderId, uint8 reason)",
  "event Quoted(bytes32 indexed market, bytes32 indexed poolId, uint64 orderId, uint64 batch)",
]);

export const TOPICS = EVENTS.map((e) => toEventSelector(e)) as Hex[];

export type PoolInfo = {
  id: Hex;
  /** Creation block; null for a seeded id the scan has not reached yet. */
  block: number | null;
  asset?: Hex;
  quote?: Hex;
  expiry?: number;
  strike?: string;
  kind?: number;
  feeBps?: number;
  bandBps?: number;
  marketId?: Hex;
};

export type BatchInfo = { index: number; price: string; units: string; nc: string; block: number };
export type OrderRef = { pool: Hex; id: string; block: number };

export type IndexStatus = {
  chainId: number;
  /** The backfill from the deploy block has finished at least once. */
  complete: boolean;
  scannedTo: number;
  head: number;
  updatedAt: number;
  error?: string;
};

type Index = {
  chainId: number;
  deployBlock: bigint;
  scannedTo: bigint;
  head: bigint;
  complete: boolean;
  pools: Map<string, PoolInfo>;
  batches: Map<string, Map<number, BatchInfo>>;
  orders: Map<string, Map<string, OrderRef>>; // owner (lowercase) -> orderKey -> ref
  removed: Set<string>;
  quotes: Set<string>;
  scan: Promise<void> | null;
  lastStart: number;
  updatedAt: number;
  failures: number;
  savedAt: number;
  /** The core this index scans: a redeploy (new address in the SDK deployments) starts a fresh index. */
  core: string;
  error?: string;
};

export const REFRESH_MS = 2_500;
/** Blocks kept behind the head: load-balanced RPCs (Chainlink) may route to an upstream one block behind. */
const HEAD_LAG = 2n;
const SAVE_EVERY_MS = 10_000;

const g = globalThis as unknown as { __confluereIndex?: Map<number, Index> };
const indexes = (g.__confluereIndex ??= new Map());

const lc = (h: string) => h.toLowerCase();
export const orderKey = (pool: string, id: bigint | string) => `${lc(pool)}:${id}`;

/**
 * Log sources per chain, widest range first. Override with LOGS_RPC_<chainId>="url|range|concurrency,...".
 * Monad: OnFinality's public endpoint serves 10,000-block ranges (one call at a time), thirdweb 1,000, the official
 * RPC 100 (logRange) at 25 req/s. HyperEVM: Chainlink's public RPC 1,000 blocks; the official one is rate-limited.
 */
export function logSources(chainId: number): LogSource[] {
  const env = process.env[`LOGS_RPC_${chainId}`];
  if (env) {
    return env.split(",").map((s) => {
      const [url, range, conc] = s.trim().split("|");
      return { url: url!, range: Number(range) || Number(logRange(chainId)), concurrency: Number(conc) || 2 };
    });
  }
  const rpcs = rpcUrlsOf(chainId);
  const step = Number(logRange(chainId));
  if (chainId === 10143) {
    return [
      { url: "https://monad-testnet.api.onfinality.io/public", range: 10_000, concurrency: 1 },
      { url: "https://10143.rpc.thirdweb.com", range: 1_000, concurrency: 2 },
      ...rpcs.map((url) => ({ url, range: step, concurrency: 4 })),
    ];
  }
  if (chainId === 998) {
    const primary = rpcs[0] ?? CHAINLINK_HYPER_TESTNET_RPC;
    return [
      { url: primary, range: step, concurrency: 6 },
      ...rpcs.slice(1).map((url) => ({ url, range: step, concurrency: 1 })),
    ];
  }
  return rpcs.map((url) => ({ url, range: 50_000, concurrency: 1 }));
}

function create(chainId: number): Index {
  const d = deploymentOf(chainId)!;
  const ix: Index = {
    chainId,
    deployBlock: BigInt(d.deployBlock),
    scannedTo: BigInt(d.deployBlock) - 1n,
    head: 0n,
    complete: false,
    pools: new Map(),
    batches: new Map(),
    orders: new Map(),
    removed: new Set(),
    quotes: new Set(),
    scan: null,
    lastStart: 0,
    updatedAt: 0,
    failures: 0,
    savedAt: 0,
    core: lc(d.confluere),
  };
  for (const id of d.pools?.poolIds ?? []) ix.pools.set(lc(id), { id, block: null });
  load(ix, d.confluere);
  return ix;
}

// ───────────────────────────── disk cache ─────────────────────────────

const cacheDir = () => process.env.CONFLUERE_INDEX_DIR || join(process.cwd(), ".next", "cache", "confluere-index");
const cacheFile = (chainId: number) => join(cacheDir(), `${chainId}.json`);

type Saved = {
  v: 1;
  core: string;
  deployBlock: string;
  scannedTo: string;
  head: string;
  complete: boolean;
  pools: PoolInfo[];
  batches: [string, BatchInfo[]][];
  orders: [string, OrderRef[]][];
  removed: string[];
  quotes: string[];
};

function load(ix: Index, core: string) {
  try {
    const j = JSON.parse(readFileSync(cacheFile(ix.chainId), "utf8")) as Saved;
    if (j.v !== 1 || lc(j.core) !== lc(core) || BigInt(j.deployBlock) !== ix.deployBlock) return;
    ix.scannedTo = BigInt(j.scannedTo);
    ix.head = BigInt(j.head);
    ix.complete = j.complete;
    for (const p of j.pools) ix.pools.set(lc(p.id), p);
    for (const [pool, rows] of j.batches) ix.batches.set(pool, new Map(rows.map((r) => [r.index, r])));
    for (const [owner, refs] of j.orders) ix.orders.set(owner, new Map(refs.map((r) => [orderKey(r.pool, r.id), r])));
    j.removed.forEach((k) => ix.removed.add(k));
    j.quotes.forEach((k) => ix.quotes.add(k));
  } catch {
    // no cache yet, or unreadable: start from the deploy block
  }
}

async function save(ix: Index) {
  if (Date.now() - ix.savedAt < SAVE_EVERY_MS) return;
  ix.savedAt = Date.now();
  const d = deploymentOf(ix.chainId)!;
  const j: Saved = {
    v: 1,
    core: d.confluere,
    deployBlock: ix.deployBlock.toString(),
    scannedTo: ix.scannedTo.toString(),
    head: ix.head.toString(),
    complete: ix.complete,
    pools: [...ix.pools.values()],
    batches: [...ix.batches].map(([k, m]) => [k, [...m.values()]]),
    orders: [...ix.orders].map(([k, m]) => [k, [...m.values()]]),
    removed: [...ix.removed],
    quotes: [...ix.quotes],
  };
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cacheFile(ix.chainId), JSON.stringify(j));
  } catch {
    // read-only file system (serverless): memory only
  }
}

/** Whether the server indexes this chain (enabled in this build and deployed). */
export const servesChain = (chainId: number) => isEnabledChain(chainId) && !!deploymentOf(chainId);

/** Apply decoded logs; every branch is idempotent. Exported for tests. */
export function applyLogs(ix: Pick<Index, "pools" | "batches" | "orders" | "removed" | "quotes">, logs: RawLog[]) {
  for (const l of logs) {
    let ev: ReturnType<typeof decodeEventLog<typeof EVENTS>>;
    try {
      ev = decodeEventLog({ abi: EVENTS, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const block = Number(BigInt(l.blockNumber));
    switch (ev.eventName) {
      case "PoolCreated": {
        const a = ev.args;
        ix.pools.set(lc(a.poolId), {
          id: a.poolId,
          block,
          asset: a.key.asset,
          quote: a.key.quote,
          expiry: Number(a.key.expiry),
          strike: a.key.strike.toString(),
          kind: a.key.kind,
          feeBps: a.feeBps,
          bandBps: a.bandBps,
          marketId: a.marketId ?? toMarketId(a.key.asset, a.key.quote, a.key.kind),
        });
        break;
      }
      case "BatchSettled": {
        const a = ev.args;
        const m = ix.batches.get(lc(a.poolId)) ?? new Map<number, BatchInfo>();
        m.set(Number(a.settleIndex), {
          index: Number(a.settleIndex),
          price: a.price.toString(),
          units: (a.competitiveUnits + a.ncUnits).toString(),
          nc: a.ncUnits.toString(),
          block,
        });
        ix.batches.set(lc(a.poolId), m);
        break;
      }
      case "OrderPlaced": {
        const a = ev.args;
        const owner = lc(a.owner);
        const m = ix.orders.get(owner) ?? new Map<string, OrderRef>();
        m.set(orderKey(a.poolId, a.orderId), { pool: a.poolId, id: a.orderId.toString(), block });
        ix.orders.set(owner, m);
        break;
      }
      case "OrderRemoved":
        ix.removed.add(orderKey(ev.args.poolId, ev.args.orderId));
        break;
      case "Quoted":
        ix.quotes.add(orderKey(ev.args.poolId, ev.args.orderId));
        break;
    }
  }
}

async function runScan(ix: Index, rpc: Rpc) {
  const d = deploymentOf(ix.chainId)!;
  const sources = logSources(ix.chainId);
  const tip = await headOf(sources, rpc);
  const head = tip > HEAD_LAG ? tip - HEAD_LAG : tip;
  if (head <= ix.scannedTo) {
    ix.head = head > ix.head ? head : ix.head;
    ix.updatedAt = Date.now();
    return;
  }
  const address = [d.confluere, ...(d.seatRegistry ? [d.seatRegistry] : [])] as Hex[];
  await scanLogs({
    from: ix.scannedTo + 1n,
    to: head,
    sources,
    rpc,
    filter: { address, topics: [TOPICS] },
    newestFirst: true,
    onLogs: (logs) => applyLogs(ix, logs),
    onProgress: (to) => {
      ix.scannedTo = to;
      ix.updatedAt = Date.now();
    },
  });
  ix.scannedTo = head > ix.scannedTo ? head : ix.scannedTo;
  ix.head = head;
  ix.complete = true;
  ix.updatedAt = Date.now();
  await save(ix);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The chain's index, refreshed in the background when older than REFRESH_MS (failures back off up to 30 s). Only
 * while the first backfill runs does a request wait, at most `waitMs`, so a cold start answers fast with partial data.
 */
export async function getIndex(chainId: number, waitMs = 1_200, rpc: Rpc = fetchRpc): Promise<Index> {
  let ix = indexes.get(chainId);
  if (!ix || ix.core !== lc(deploymentOf(chainId)!.confluere)) indexes.set(chainId, (ix = create(chainId)));
  const gap = ix.failures ? Math.min(30_000, REFRESH_MS * 2 ** ix.failures) : REFRESH_MS;
  if (!ix.scan && Date.now() - ix.lastStart >= gap) {
    const it = ix;
    it.lastStart = Date.now();
    it.scan = runScan(it, rpc)
      .then(() => {
        it.failures = 0;
        it.error = undefined;
      })
      .catch((e: unknown) => {
        it.failures++;
        it.error = String((e as Error)?.message ?? e).slice(0, 200);
      })
      .finally(() => {
        it.scan = null;
      });
  }
  // only a cold index (first backfill still running) makes the request wait; a warm one answers at once and the
  // refresh lands for the next request
  if (ix.scan && waitMs > 0 && !ix.complete) await Promise.race([ix.scan, sleep(waitMs)]);
  return ix;
}

/**
 * Keep an unfinished scan running after the response is sent. On serverless hosts (Vercel) a function is frozen once
 * it answers, so a cold backfill that needs more than one request's wait (Monad: many log chunks) would never finish;
 * `after` keeps the function alive until the scan settles (bounded by the route's maxDuration). Outside a request
 * scope (tests, scripts) it is a no-op.
 */
export function keepScanning(ix: Index): void {
  const scan = ix.scan;
  if (!scan) return;
  try {
    after(() => scan.catch(() => undefined));
  } catch {
    // not inside a request (unit tests): nothing to keep alive
  }
}

export function statusOf(ix: Index): IndexStatus {
  return {
    chainId: ix.chainId,
    complete: ix.complete,
    scannedTo: Number(ix.scannedTo),
    head: Number(ix.head > ix.scannedTo ? ix.head : ix.scannedTo),
    updatedAt: ix.updatedAt,
    ...(ix.error ? { error: ix.error } : {}),
  };
}

/** Known pools, oldest first (seeded ids the scan has not reached last). */
export function poolsOf(ix: Index): PoolInfo[] {
  return [...ix.pools.values()].sort((a, b) => (a.block ?? Infinity) - (b.block ?? Infinity));
}

/** Clearing-price history of one pool, newest first. */
export function batchesOf(ix: Index, pool: string): BatchInfo[] {
  return [...(ix.batches.get(lc(pool))?.values() ?? [])].sort((a, b) => b.index - a.index);
}

/** Last clearing price per pool (for list views that want a sparkline-free summary). */
export function lastBatchOf(ix: Index): Record<string, BatchInfo> {
  const out: Record<string, BatchInfo> = {};
  for (const [pool, m] of ix.batches) {
    let best: BatchInfo | undefined;
    for (const b of m.values()) if (!best || b.index > best.index) best = b;
    if (best) out[pool] = best;
  }
  return out;
}

/** Orders `owner` placed that have not been removed (filled-and-removed, cancelled, purged). Verify with `order()`. */
export function ordersOf(ix: Index, owner: string): OrderRef[] {
  return [...(ix.orders.get(lc(owner))?.entries() ?? [])].filter(([k]) => !ix.removed.has(k)).map(([, v]) => v);
}

export const quoteKeysOf = (ix: Index): string[] => [...ix.quotes];

/** Test hook: forget every index. */
export const _resetIndexes = () => indexes.clear();
