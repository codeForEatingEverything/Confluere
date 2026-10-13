/**
 * Server-side eth_getLogs scanner (route handlers only). Walks a block range in chunks sized for the first source,
 * runs `concurrency` chunks at a time, retries a failing chunk once with backoff, then splits it into the next
 * source's range and tries that source (public RPCs differ: Monad's official endpoint takes 100 blocks per call at
 * 25 req/s, OnFinality's public one 10,000 blocks at about one call at a time). Logs are handed over per chunk;
 * `onProgress` reports the highest block below which every chunk is done (the scanned range stays contiguous).
 */
import type { Hex } from "viem";

export type LogSource = { url: string; range: number; concurrency: number };

export type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
};

export type LogFilter = { address: Hex | Hex[]; topics?: (Hex | Hex[] | null)[] };

export type Rpc = (url: string, method: string, params: unknown[]) => Promise<unknown>;

const hex = (n: bigint) => `0x${n.toString(16)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-RPC over fetch with a timeout; JSON-RPC errors and HTTP errors throw. */
export const fetchRpc: Rpc = async (url, method, params) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const text = await r.text();
  let j: { result?: unknown; error?: { message?: string; code?: number } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  }
  if (j.error) throw new Error(`${new URL(url).host} ${j.error.code ?? ""} ${j.error.message ?? "error"}`.trim());
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return j.result;
};

/** Head block from the first source that answers. */
export async function headOf(sources: Pick<LogSource, "url">[], rpc: Rpc = fetchRpc): Promise<bigint> {
  let last: unknown;
  for (const s of sources) {
    for (let a = 0; a < 2; a++) {
      try {
        return BigInt((await rpc(s.url, "eth_blockNumber", [])) as string);
      } catch (e) {
        last = e;
        await sleep(250 * (a + 1));
      }
    }
  }
  throw last instanceof Error ? last : new Error("no RPC answered eth_blockNumber");
}

/** [from, to] split into inclusive chunks of at most `size` blocks. */
export function chunks(from: bigint, to: bigint, size: number): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  const step = BigInt(Math.max(1, size));
  for (let f = from; f <= to; f += step) out.push([f, f + step - 1n < to ? f + step - 1n : to]);
  return out;
}

async function getLogs(rpc: Rpc, s: LogSource, filter: LogFilter, from: bigint, to: bigint): Promise<RawLog[]> {
  return (await rpc(s.url, "eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }])) as RawLog[];
}

/** One chunk through the source chain: source `level`, retried once, then split over the next source. */
async function fetchChunk(rpc: Rpc, sources: LogSource[], level: number, filter: LogFilter, from: bigint, to: bigint, backoffMs: number): Promise<RawLog[]> {
  const s = sources[level]!;
  let err: unknown;
  if (to - from + 1n <= BigInt(s.range)) {
    for (let a = 0; a < 2; a++) {
      try {
        return await getLogs(rpc, s, filter, from, to);
      } catch (e) {
        err = e;
        if (/range|too large|exceed|limit exceeded/i.test(String((e as Error)?.message))) break; // retrying will not help
        await sleep(backoffMs * (a + 1));
      }
    }
  }
  if (level + 1 >= sources.length) throw err instanceof Error ? err : new Error(`getLogs failed for ${from}-${to}`);
  const next = sources[level + 1]!;
  const parts = chunks(from, to, next.range);
  const out: RawLog[] = [];
  await pool(parts, Math.max(1, next.concurrency), async ([f, t]) => {
    out.push(...(await fetchChunk(rpc, sources, level + 1, filter, f, t, backoffMs)));
  });
  return out;
}

/** Run `fn` over `items` with at most `n` in flight; the first failure stops new work and rejects. */
export async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (failed === undefined && next < items.length) {
        const i = next++;
        try {
          await fn(items[i]!, i);
        } catch (e) {
          failed ??= e;
        }
      }
    }),
  );
  if (failed !== undefined) throw failed;
}

export type ScanOptions = {
  from: bigint;
  to: bigint;
  sources: LogSource[];
  filter: LogFilter;
  rpc?: Rpc;
  backoffMs?: number;
  onLogs: (logs: RawLog[], from: bigint, to: bigint) => void;
  /** Every block <= the reported one has been read. */
  onProgress?: (scannedTo: bigint) => void;
  /**
   * Read the newest chunks first (a cold backfill shows recent pools, the ones still trading, before old ones).
   * Progress then only advances once the oldest chunk is in, which is what keeps the scanned range contiguous.
   */
  newestFirst?: boolean;
};

/**
 * Scan [from, to]. Resolves when every chunk is read; rejects on the first chunk no source could serve (chunks read
 * before it stay delivered and the progress reported so far stays valid).
 */
export async function scanLogs(o: ScanOptions): Promise<void> {
  if (o.from > o.to || o.sources.length === 0) return;
  const rpc = o.rpc ?? fetchRpc;
  const first = o.sources[0]!;
  const parts = chunks(o.from, o.to, first.range);
  const done = new Array<boolean>(parts.length).fill(false);
  let prefix = 0;
  const order = parts.map((_, i) => i);
  if (o.newestFirst) order.reverse();
  await pool(order, Math.max(1, first.concurrency), async (i) => {
    const [f, t] = parts[i]!;
    const logs = await fetchChunk(rpc, o.sources, 0, o.filter, f, t, o.backoffMs ?? 300);
    o.onLogs(logs, f, t);
    done[i] = true;
    let moved = false;
    while (prefix < parts.length && done[prefix]) {
      prefix++;
      moved = true;
    }
    if (moved) o.onProgress?.(parts[prefix - 1]![1]);
  });
}
