"use client";

/**
 * Protocol reads. Every hook reads the ACTIVE chain (lib/activeChain): its public client, its deployment, and query
 * keys shaped [name, chainId, ...] so caches never mix networks (lib/network reads that shape for its status line).
 * Event history (pool discovery, clearing prices, an account's orders, seat quotes) comes from this app's own
 * /api routes (server-side index, lib/server/chainIndex); live state comes straight from the chain via Multicall3.
 */
import { readMany, readManySafe } from "./many";
import { useQueries, useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { erc20Abi, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import {
  confluereAbi,
  erc6909WrapperFactoryAbi,
  vaultAbi,
  vaultFactoryAbi,
  cTokenId,
  rTokenId,
  marketId,
  logRange,
  Side,
  Status,
  type Deployment,
  type Kind,
} from "@confluere/sdk";
import { useActiveChain } from "./activeChain";
import { deploymentOf } from "./chains";
import { MAX_TTL } from "./window";
import { appFetch } from "./demo/client";
import { useDemoClientOr } from "./demo/hooks";
import { useViewAddress } from "./demo/hooks";
import { feeFields, v07StatsAbi, v08Abi, type GraduationBasis } from "./v08";

export const REFRESH_MS = 8000;

/**
 * A token as the screens name it: the contract's own symbol. The wrapped coin keeps its own name (WHYPE / WMON) and is
 * a separate entry from the network's coin (HYPE / MON, lib/native NATIVE) in every token list (
 * this undoes the 2026-10-13 merge that showed WHYPE as HYPE). `onchainSymbol` is optional and only set by callers that
 * relabel a token row.
 */
export type Token = { address: Address; symbol: string; decimals: number; onchainSymbol?: string };

/** The contract's own symbol (WHYPE rather than HYPE). */
export const onchainSymbol = (t: Pick<Token, "symbol" | "onchainSymbol"> | undefined) => t?.onchainSymbol ?? t?.symbol;

export type PoolRow = {
  id: Hex;
  asset: Address;
  quote: Address;
  expiry: number;
  strike: bigint;
  kind: Kind;
  status: Status;
  assetDecimals: number;
  feeBps: number; // pre-v0.8 cores only (0 on v0.8: fees are fixed, Settlement.sol)
  bandBps: number;
  bandFailures: number; // consecutive batches where at-price orders could not fill; the band widens 1.5x each
  bandBase: bigint; // centre of the at-price band
  lastClearingPrice: bigint;
  feeEscrow: bigint; // v0.8: 5% of (K − P) withheld from borrowers at clearing, split at close by repaid share
  filledUnits: bigint; // v0.8: units ever filled in this pool (denominator of the escrow split)
  repaidUnits: bigint; // v0.8: repaid + rolled + bid-filled units (numerator: the treasury's part)
  settleCount: number;
  windowEnd: bigint;
  pausedUntil: bigint;
  quoteBal: bigint;
  assetBal: bigint;
  surplusBal: bigint;
  nextBatchAt: number;
  batchInterval: number; // long-tail pools batch every 12 or 48 base intervals
  cadence: number;
  minFill: bigint;
  firstLo: bigint;
  firstHi: bigint;
  autoSell?: boolean; // v0.8 PoolOptions.autoSell (decision B); absent on a pre-v0.8 core
  graduated: boolean; // market passed four clean cycles; ungraduated pools are shown greyed with a notice
  expiryWindowEnd: bigint; // shared repayment window of this expiry (0 until the first pool of it matures)
  block: bigint; // block the row was read at (pause and window checks)
};

/** Public client, deployment and id of the active chain: the context every data hook reads with. */
export function useChainCtx() {
  const { chainId, deployment } = useActiveChain();
  // demo mode (lib/demo): the sample network answers every read through the same client interface
  const client = useDemoClientOr(usePublicClient({ chainId }) as PublicClient | undefined, chainId);
  return { chainId, deployment, client, ready: !!client && !!deployment };
}

/** Keep the previous result while a key changes on the SAME chain (ids list grew), never across chains. */
const sameChain = <T,>(prev: T | undefined, q: { queryKey: readonly unknown[] } | undefined, chainId: number) =>
  q && q.queryKey[1] === chainId ? prev : undefined;

const coreOf = (client: PublicClient, core?: Address): Address => {
  const c = core ?? deploymentOf(client.chain?.id ?? 0)?.confluere;
  if (!c) throw new Error(`no deployment on chain ${client.chain?.id}`);
  return c;
};

// ───────────────────────────── pool discovery (server index) ─────────────────────────────

export type IndexStatus = { chainId: number; complete: boolean; scannedTo: number; head: number; updatedAt: number; error?: string };
export type PoolIndexEntry = {
  id: Hex;
  block: number | null;
  asset?: Address;
  quote?: Address;
  expiry?: number;
  strike?: string;
  kind?: number;
  feeBps?: number;
  bandBps?: number;
  marketId?: Hex;
};
export type PoolIndex = { status: IndexStatus; pools: PoolIndexEntry[]; last: Record<string, { index: number; price: string; units: string; nc: string; block: number }> };

async function getJson<T>(url: string): Promise<T> {
  const r = await appFetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url.split("?")[0]} ${r.status}`);
  return (await r.json()) as T;
}

/** The deployment's seeded pool ids: what the app shows if the index route cannot be reached. */
export const seedPoolIds = (d: Deployment | undefined): Hex[] => d?.pools?.poolIds ?? [];

/**
 * Pool ids known on the active chain (GET /api/pools). Polls fast (1.5 s) while the server's first backfill runs,
 * then every 15 s. On failure the seeded ids stand in, flagged by `fallback: true`.
 */
export function usePoolIndex() {
  const { chainId, deployment } = useActiveChain();
  const q = useQuery({
    queryKey: ["pool-index", chainId],
    enabled: !!deployment,
    queryFn: () => getJson<PoolIndex>(`/api/pools?chain=${chainId}`),
    refetchInterval: (query) => (query.state.data?.status.complete ? 15_000 : 1_500),
    retry: 3,
  });
  const fallback = !q.data && q.isError;
  const ids: Hex[] = q.data ? q.data.pools.map((p) => p.id) : fallback ? seedPoolIds(deployment) : [];
  return { ...q, ids, fallback, complete: q.data?.status.complete ?? false };
}

export async function readPools(client: PublicClient, ids: Hex[], core?: Address): Promise<PoolRow[]> {
  if (ids.length === 0) return [];
  const c = coreOf(client, core);
  const res = await readMany(client, ids.flatMap((id) => [
      { address: c, abi: confluereAbi, functionName: "pool", args: [id] } as const,
      { address: c, abi: confluereAbi, functionName: "nextBatchAt", args: [id] } as const,
    ]));
  const views = ids.map((_, i) => res[2 * i] as any);
  const markets = [...new Set(views.map((v) => marketId(v.key.asset, v.key.quote, Number(v.key.kind))))];
  const expiries = [...new Set(views.map((v) => BigInt(v.key.expiry)))];
  const [extra, block] = await Promise.all([
    readMany(client, [
      ...markets.map((m) => ({ address: c, abi: confluereAbi, functionName: "graduated", args: [m] }) as const),
      ...expiries.map((e) => ({ address: c, abi: confluereAbi, functionName: "expiryWindowEnd", args: [e] }) as const),
    ]),
    client.getBlockNumber({ cacheTime: 1_000 }),
  ]);
  const grad = new Map(markets.map((m, i) => [m, extra[i] as boolean]));
  const wend = new Map(expiries.map((e, i) => [e, extra[markets.length + i] as bigint]));
  return ids.map((id, i) => {
    const v = views[i];
    return {
      id,
      asset: v.key.asset,
      quote: v.key.quote,
      expiry: Number(v.key.expiry),
      strike: v.key.strike,
      kind: v.key.kind,
      status: v.status,
      assetDecimals: v.assetDecimals,
      feeBps: Number(v.feeBps ?? 0),
      bandBps: Number(v.bandBps ?? v.key.bandBps ?? 0),
      bandFailures: Number(v.bandFailures),
      bandBase: v.bandBase,
      lastClearingPrice: v.lastClearingPrice,
      ...feeFields(v),
      settleCount: v.settleCount,
      windowEnd: v.windowEnd,
      pausedUntil: v.pausedUntil,
      quoteBal: v.quoteBal,
      assetBal: v.assetBal,
      surplusBal: v.surplusBal,
      nextBatchAt: Number(res[2 * i + 1]),
      batchInterval: Number(v.batchInterval),
      cadence: Number(v.options.cadence),
      minFill: v.options.minFill,
      firstLo: v.options.firstLo,
      firstHi: v.options.firstHi,
      graduated: grad.get(marketId(v.key.asset, v.key.quote, Number(v.key.kind))) ?? false,
      expiryWindowEnd: wend.get(BigInt(v.key.expiry)) ?? 0n,
      block,
    };
  });
}

/**
 * Live state of every known pool on the active chain: ids from usePoolIndex, state in one Multicall3 round trip.
 * `isLoading` is true only until the first rows arrive; `discovering` while the server backfill is still running.
 */
export function usePools() {
  const { chainId, client, deployment, ready } = useChainCtx();
  const index = usePoolIndex();
  const ids = index.ids;
  const q = useQuery({
    queryKey: ["pools", chainId, ids],
    enabled: ready && ids.length > 0,
    refetchInterval: REFRESH_MS,
    placeholderData: (prev, prevQuery) => sameChain(prev, prevQuery, chainId),
    queryFn: () => readPools(client!, ids, deployment!.confluere),
  });
  const waitingIds = !index.data && !index.isError && !!deployment;
  return {
    ...q,
    data: ids.length === 0 && index.data ? ([] as PoolRow[]) : q.data,
    isLoading: q.isLoading || waitingIds,
    isError: q.isError || (index.isError && ids.length === 0),
    error: q.error ?? (ids.length === 0 ? index.error : null),
    discovering: !index.complete,
    fallback: index.fallback,
  };
}

export function usePool(id: Hex | undefined) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["pool", chainId, id],
    enabled: ready && !!id,
    refetchInterval: REFRESH_MS,
    queryFn: async () => (await readPools(client!, [id!], deployment!.confluere))[0]!,
  });
}

export function useTokens(addresses: Address[]) {
  const { chainId, client } = useChainCtx();
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase() as Address))].sort();
  return useQuery({
    queryKey: ["tokens", chainId, uniq],
    enabled: !!client && uniq.length > 0,
    staleTime: Infinity,
    placeholderData: (prev, prevQuery) => sameChain(prev, prevQuery, chainId),
    queryFn: async () => {
      const r = await readMany(client!, uniq.flatMap((a) => [
          { address: a, abi: erc20Abi, functionName: "symbol" } as const,
          { address: a, abi: erc20Abi, functionName: "decimals" } as const,
        ]));
      const map: Record<string, Token> = {};
      uniq.forEach((a, i) => (map[a] = { address: a, symbol: r[2 * i] as string, decimals: Number(r[2 * i + 1]) }));
      return map;
    },
  });
}

// ───────────────────────────── order book ─────────────────────────────

export type BookOrder = { id: bigint; owner: Address; side: number; units: bigint; limit: bigint; escrow: bigint; deadline: number };

export async function walk(client: PublicClient, pid: Hex, side: Side, max = 128, core?: Address): Promise<BookOrder[]> {
  const c = coreOf(client, core);
  let [id] = await client.readContract({ address: c, abi: confluereAbi, functionName: "bookHead", args: [pid, side] });
  const out: BookOrder[] = [];
  while (id !== 0n && out.length < max) {
    const o = await client.readContract({ address: c, abi: confluereAbi, functionName: "order", args: [pid, id] });
    // v0.8 Order: owner, side, flags, units, limit, escrow, deadline, next
    out.push({ id, owner: o[0], side: o[1], units: o[3], limit: o[4], escrow: o[5], deadline: o[6] });
    id = o[7];
  }
  return out;
}

export type Book = { sells: BookOrder[]; buys: BookOrder[]; ncSells: BookOrder[]; ncBuys: BookOrder[]; bids: BookOrder[] };

/** All five sorted sets of one pool's on-chain book (the five walks run side by side, so each step is one multicall). */
export async function readBook(client: PublicClient, pid: Hex, core?: Address): Promise<Book> {
  const [sells, buys, ncSells, ncBuys, bids] = await Promise.all(
    [Side.Sell, Side.Buy, Side.NcSell, Side.NcBuy, Side.Bid].map((s) => walk(client, pid, s, 128, core)),
  );
  return { sells: sells!, buys: buys!, ncSells: ncSells!, ncBuys: ncBuys!, bids: bids! };
}

export const bookOrders = (b: Book): BookOrder[] => [...b.sells, ...b.buys, ...b.ncSells, ...b.ncBuys, ...b.bids];

export function useBook(pid: Hex | undefined) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["book", chainId, pid],
    enabled: ready && !!pid,
    refetchInterval: REFRESH_MS,
    queryFn: () => readBook(client!, pid!, deployment!.confluere),
  });
}

/** Books of several pools at once (Developers purge column). Prefer useAccountOrders for "my orders". */
export function useBooks(ids: Hex[]) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["books", chainId, ids],
    enabled: ready && ids.length > 0,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async () => {
      const books = await Promise.all(ids.map((id) => readBook(client!, id, deployment!.confluere)));
      return Object.fromEntries(ids.map((id, i) => [id, books[i]!])) as Record<string, Book>;
    },
  });
}

/** An order of the connected account, with its pool. */
export type AccountOrder = BookOrder & { pid: Hex };

/**
 * The connected account's live orders on the active chain, across all pools: candidates from GET /api/orders
 * (OrderPlaced without OrderRemoved), each confirmed with `order(pool, id)` in one multicall. Orders whose owner
 * no longer matches (removed after the index last ran) are dropped.
 */
export function useAccountOrders(owner?: Address) {
  const { chainId, client, deployment, ready } = useChainCtx();
  const address = useViewAddress();
  const who = owner ?? address;
  return useQuery({
    queryKey: ["account-orders", chainId, who?.toLowerCase()],
    enabled: ready && !!who,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async (): Promise<AccountOrder[]> => {
      const j = await getJson<{ orders: { pool: Hex; id: string }[] }>(`/api/orders?chain=${chainId}&owner=${who}`);
      if (j.orders.length === 0) return [];
      const core = deployment!.confluere;
      const r = await readManySafe(client!, j.orders.map((o) => ({ address: core, abi: confluereAbi, functionName: "order", args: [o.pool, BigInt(o.id)] }) as const));
      const out: AccountOrder[] = [];
      j.orders.forEach((o, i) => {
        const v = r[i] as readonly [Address, number, bigint, bigint, bigint, number, bigint] | undefined;
        if (!v || v[0].toLowerCase() !== who!.toLowerCase()) return;
        out.push({ pid: o.pool, id: BigInt(o.id), owner: v[0], side: v[1], units: v[2], limit: v[3], escrow: v[4], deadline: v[5] });
      });
      return out;
    },
  });
}

/** Order ids (of `pid`) that are rollover orders: `rolloverSource` is set for them. */
export function useRolloverIds(pid: Hex, ids: bigint[]) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["rollover-ids", chainId, pid, ids.map(String)],
    enabled: ready && ids.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await readMany(client!, ids.map((id) => ({ address: deployment!.confluere, abi: confluereAbi, functionName: "rolloverSource", args: [pid, id] }) as const));
      return new Set(ids.filter((_, i) => BigInt(r[i] as Hex) !== 0n).map(String));
    },
  });
}

/**
 * Old pool of each rollover order among `orders` (orderKey → old pool id); plain orders are absent. Feeds the purge
 * rule for rollover orders whose old window has ended (lib/due rolloverDead).
 */
export function useRolloverSources(orders: { pid: Hex; id: bigint }[]) {
  const { chainId, client, deployment, ready } = useChainCtx();
  const keys = orders.map((o) => orderKey(o.pid, o.id));
  return useQuery({
    queryKey: ["rollover-sources", chainId, keys],
    enabled: ready && orders.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await readMany(client!, orders.map((o) => ({ address: deployment!.confluere, abi: confluereAbi, functionName: "rolloverSource", args: [o.pid, o.id] }) as const));
      const m = new Map<string, Hex>();
      keys.forEach((k, i) => BigInt(r[i] as Hex) !== 0n && m.set(k, r[i] as Hex));
      return m;
    },
  });
}

/** Key of an order across pools, as used by useRolloverKeys / useSeatOrderKeys. */
export const orderKey = (pid: Hex, id: bigint) => `${pid.toLowerCase()}:${id}`;

/** Rollover orders among orders of several pools (Portfolio → Orders): keys (orderKey) whose `rolloverSource` is set. */
export function useRolloverKeys(orders: { pid: Hex; id: bigint }[]) {
  const { chainId, client, deployment, ready } = useChainCtx();
  const keys = orders.map((o) => orderKey(o.pid, o.id));
  return useQuery({
    queryKey: ["rollover-keys", chainId, keys],
    enabled: ready && orders.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const r = await readMany(client!, orders.map((o) => ({ address: deployment!.confluere, abi: confluereAbi, functionName: "rolloverSource", args: [o.pid, o.id] }) as const));
      return new Set(keys.filter((_, i) => BigInt(r[i] as Hex) !== 0n));
    },
  });
}

// ───────────────────────────── seat obligation orders ─────────────────────────────

const quoted = parseAbiItem("event Quoted(bytes32 indexed market, bytes32 indexed poolId, uint64 orderId, uint64 batch)");
/** Quoted scan state: the block range [from, to] already read (from = -1n before the first scan) and the keys found. */
export type QuotedScan = { from: bigint; to: bigint; keys: Set<string> };

/**
 * How far back (seconds) a seat obligation order that is still locked can have been posted. A lock needs the pool
 * Open before expiry, and a pool is listed at most `maxExpiries` periods before its expiry (Grid.isListableExpiry),
 * so nothing older than that horizon can still be locked. A lock also ends after its ttl (at most MAX_TTL settlements,
 * one per batch interval of the pool), which is the tighter bound when batches are settled on time.
 */
export function seatLockLookback(pools: Pick<PoolRow, "batchInterval">[], grid: { period: number; maxExpiries: number }): number {
  const horizon = grid.period * grid.maxExpiries;
  const iv = Math.max(0, ...pools.map((p) => p.batchInterval));
  return Math.min(horizon, MAX_TTL * iv);
}

/**
 * First block the Quoted scan has to cover: `lookbackS` back from the head at the measured block time (with a 25%
 * margin), never before the deploy block. Without a block time (anvil automine) it is the deploy block.
 */
export function quotedScanFrom(o: { head: bigint; deployBlock: bigint; lookbackS: number; spb: number | null | undefined }): bigint {
  let from = o.deployBlock;
  if (o.spb && o.spb > 0) {
    const back = BigInt(Math.ceil((o.lookbackS * 1.25) / o.spb));
    if (o.head - back > from) from = o.head - back;
  }
  return from;
}

/**
 * Block ranges a scan still has to read to cover [start, head], given what was already read (`scanned`): the new
 * blocks after `scanned.to` and, when this caller needs to start earlier than any previous one, the gap before
 * `scanned.from`.
 */
export function quotedScanRanges(start: bigint, head: bigint, scanned: Pick<QuotedScan, "from" | "to">): [bigint, bigint][] {
  if (scanned.from < 0n || scanned.to < 0n) return start <= head ? [[start, head]] : [];
  const out: [bigint, bigint][] = [];
  if (start < scanned.from) out.push([start, scanned.from - 1n]);
  const after = scanned.to + 1n > start ? scanned.to + 1n : start;
  if (after <= head) out.push([after, head]);
  return out;
}

/**
 * Client-side Quoted scan over the lookback window (kept for tools and tests; the app reads GET /api/seat-quotes,
 * which covers the whole history from the server index). The scanned range [from, to] stays contiguous.
 */
export async function seatOrderKeys(
  client: Pick<PublicClient, "getBlockNumber" | "getLogs"> & { chain?: { id: number } },
  lookbackS: number,
  spb: number | null | undefined,
  st: QuotedScan,
  d: Pick<Deployment, "seatRegistry" | "deployBlock">,
  chainId: number = client.chain?.id ?? 31337,
): Promise<Set<string>> {
  if (!d.seatRegistry) return st.keys;
  const head = await client.getBlockNumber();
  const step = logRange(chainId);
  const start = quotedScanFrom({ head, deployBlock: BigInt(d.deployBlock), lookbackS, spb });
  if (st.to >= 0n && start > st.to + 1n) {
    st.from = -1n;
    st.to = -1n;
  }
  for (const [lo, hi] of quotedScanRanges(start, head, st)) {
    for (let from = lo; from <= hi; from += step) {
      const to = from + step - 1n < hi ? from + step - 1n : hi;
      const logs = await client.getLogs({ address: d.seatRegistry, event: quoted, fromBlock: from, toBlock: to });
      for (const l of logs) if (l.args.poolId && l.args.orderId !== undefined) st.keys.add(orderKey(l.args.poolId, l.args.orderId));
      if (st.from < 0n) st.from = lo;
      if (to > st.to) st.to = to;
    }
    if (lo < st.from) st.from = lo;
  }
  return new Set(st.keys);
}

/**
 * Seat obligation orders on the active chain (orderKey strings), from GET /api/seat-quotes. Disabled when no pool
 * could hold a locked order (`pools` empty) or the deployment has no seat registry. On error, seatLockState treats
 * orders as not locked (the core still rejects a locked cancel with its own message).
 */
export function useSeatOrderKeys(pools: Pick<PoolRow, "batchInterval">[]) {
  const { chainId, deployment } = useActiveChain();
  const q = useQuery({
    queryKey: ["seat-order-keys", chainId],
    enabled: pools.length > 0 && !!deployment?.seatRegistry,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async () => new Set((await getJson<{ keys: string[] }>(`/api/seat-quotes?chain=${chainId}`)).keys),
  });
  return { data: q.data, isSuccess: q.isSuccess, isError: q.isError, error: q.error };
}

// ───────────────────────────── clearing history ─────────────────────────────

export type BatchRow = { index: number; price: bigint; units: bigint; nc: bigint; block: bigint };

/** Clearing-price history of one pool, newest first (GET /api/batches). */
export function useBatches(pid: Hex | undefined) {
  const { chainId, deployment } = useActiveChain();
  return useQuery({
    queryKey: ["batches", chainId, pid],
    enabled: !!deployment && !!pid,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async (): Promise<BatchRow[]> => {
      const j = await getJson<{ rows: { index: number; price: string; units: string; nc: string; block: number }[] }>(
        `/api/batches?chain=${chainId}&pool=${pid}`,
      );
      return j.rows.map((r) => ({ index: r.index, price: BigInt(r.price), units: BigInt(r.units), nc: BigInt(r.nc), block: BigInt(r.block) }));
    },
  });
}

/**
 * Round history of several pools at once (one GET /api/batches each, sharing useBatches' cache), keyed by pool id;
 * the charts merge maturities that share a buy-back price. `isLoading` until every pool answered once.
 */
export function useBatchesMany(ids: Hex[]) {
  const { chainId, deployment } = useActiveChain();
  const qs = useQueries({
    queries: ids.map((pid) => ({
      queryKey: ["batches", chainId, pid],
      enabled: !!deployment,
      refetchInterval: REFRESH_MS * 2,
      queryFn: async (): Promise<BatchRow[]> => {
        const j = await getJson<{ rows: { index: number; price: string; units: string; nc: string; block: number }[] }>(`/api/batches?chain=${chainId}&pool=${pid}`);
        return j.rows.map((r) => ({ index: r.index, price: BigInt(r.price), units: BigInt(r.units), nc: BigInt(r.nc), block: BigInt(r.block) }));
      },
    })),
  });
  const data: Record<string, BatchRow[]> = {};
  ids.forEach((id, i) => {
    const d = qs[i]?.data;
    if (d) data[id] = d;
  });
  return { data, isLoading: qs.some((q) => q.isLoading), isError: qs.some((q) => q.isError && !q.data) };
}

// ───────────────────────────── time ─────────────────────────────

/** Latest block of the active chain: `ts` is its timestamp (compare with expiries like the contract), `wall` local time. */
export function useNow() {
  const { chainId, client } = useChainCtx();
  return useQuery({
    queryKey: ["now", chainId],
    enabled: !!client,
    refetchInterval: 6000,
    queryFn: async () => {
      const b = await client!.getBlock();
      return { ts: Number(b.timestamp), block: b.number, wall: Date.now() / 1000 };
    },
  });
}

/** Blocks the block-time sample spans (fewer on a young chain). */
export const BLOCK_TIME_SPAN = 1000n;

/**
 * Average seconds per block over the last `BLOCK_TIME_SPAN` blocks (head and head − N). Undefined when the chain
 * is too young or its timestamps do not advance (anvil automine), so callers show blocks without a time estimate.
 */
export async function measureBlockTime(client: Pick<PublicClient, "getBlock">, span = BLOCK_TIME_SPAN): Promise<number | null> {
  const head = await client.getBlock();
  const n = head.number < span ? head.number : span;
  if (n <= 0n) return null;
  const past = await client.getBlock({ blockNumber: head.number - n });
  const dt = Number(head.timestamp - past.timestamp);
  return dt > 0 ? dt / Number(n) : null;
}

/**
 * Measured seconds per block on the active chain (null when it cannot be measured). Every "≈ time" shown for a
 * block count goes through this: repayment windows count blocks.
 */
export function useBlockTime() {
  const { chainId, client } = useChainCtx();
  return useQuery({
    queryKey: ["block-time", chainId],
    enabled: !!client,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: () => measureBlockTime(client!),
  });
}

// ───────────────────────────── vaults ─────────────────────────────

export type VaultRow = {
  address: Address;
  name: string;
  symbol: string;
  quote: Address;
  epoch: bigint;
  targetExpiry: number;
  totalAssets: bigint;
  totalSupply: bigint;
  kind: number;
  strikeRule: number;
  capBps: number;
  maxPriceBps: number;
  assets: Address[];
  lastPokeBatch: number;
  pendingDeposits: bigint;
  pendingRedeems: bigint;
};

const VAULT_FIELDS = ["name", "symbol", "asset", "epoch", "targetExpiry", "totalAssets", "totalSupply", "kind", "strikeRule", "perBatchCapBps", "maxPriceBps", "assets", "lastPokeBatch", "pendingDepositAssets", "pendingRedeemShares"] as const;

export async function readVaults(client: PublicClient, factory: Address): Promise<VaultRow[]> {
  const n = await client.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "vaultsLength" });
  const addrs = (await readMany(client, Array.from({ length: Number(n) }, (_, i) => ({ address: factory, abi: vaultFactoryAbi, functionName: "vaults", args: [BigInt(i)] }) as const))) as Address[];
  const r = await readMany(client, addrs.flatMap((address) => VAULT_FIELDS.map((functionName) => ({ address, abi: vaultAbi, functionName }) as const)));
  const k = VAULT_FIELDS.length;
  return addrs.map((address, i) => {
    const v = r.slice(i * k, (i + 1) * k);
    return {
      address,
      name: v[0] as string,
      symbol: v[1] as string,
      quote: v[2] as Address,
      epoch: v[3] as bigint,
      targetExpiry: Number(v[4]),
      totalAssets: v[5] as bigint,
      totalSupply: v[6] as bigint,
      kind: Number(v[7]),
      strikeRule: Number(v[8]),
      capBps: Number(v[9]),
      maxPriceBps: Number(v[10]),
      assets: v[11] as Address[],
      lastPokeBatch: Number(v[12]),
      pendingDeposits: v[13] as bigint,
      pendingRedeems: v[14] as bigint,
    };
  });
}

/** Every vault of the active chain's factory, read in two multicalls. */
export function useVaults() {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["vaults", chainId],
    enabled: ready,
    refetchInterval: REFRESH_MS * 2,
    queryFn: () => readVaults(client!, deployment!.vaultFactory),
  });
}

/** Total supply of each pool's C (lender) and R (unrepaid buy-back right) ids, for claim estimates and auctions. */
export function usePoolSupplies(ids: Hex[]) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["supplies", chainId, ids],
    enabled: ready && ids.length > 0,
    refetchInterval: REFRESH_MS,
    placeholderData: (prev, prevQuery) => sameChain(prev, prevQuery, chainId),
    queryFn: async () => {
      const core = deployment!.confluere;
      const r = await readMany(client!, ids.flatMap((id) => [
        { address: core, abi: confluereAbi, functionName: "totalSupply", args: [cTokenId(id)] } as const,
        { address: core, abi: confluereAbi, functionName: "totalSupply", args: [rTokenId(id)] } as const,
      ]));
      return Object.fromEntries(ids.map((id, i) => [id, { c: r[2 * i] as bigint, r: r[2 * i + 1] as bigint }])) as Record<string, { c: bigint; r: bigint }>;
    },
  });
}

export type ExpiryStats = { expiry: number; volume: bigint; fees: bigint; bad: boolean };

/**
 * Per-expiry market stats (graduation inputs) and the published threshold for the market's quote token. v0.8 cores
 * graduate on treasury fees (`basis: "fees"`, MarketStats.fees vs graduationFee); older ones on volume.
 */
export function useMarketStats(market: { id: Hex; quote: Address } | undefined, expiries: number[]) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["market-stats", chainId, market?.id, expiries],
    enabled: ready && !!market && expiries.length > 0,
    refetchInterval: REFRESH_MS * 4,
    queryFn: async () => {
      const core = deployment!.confluere;
      const [fee] = await readManySafe(client!, [{ address: core, abi: v08Abi, functionName: "graduationFee", args: [market!.quote] } as const]);
      const basis: GraduationBasis = fee === undefined ? "volume" : "fees";
      const r = await readMany(client!, [
        basis === "fees"
          ? ({ address: core, abi: v08Abi, functionName: "graduationFee", args: [market!.quote] } as const)
          : ({ address: core, abi: v08Abi, functionName: "graduationVolume", args: [market!.quote] } as const),
        ...expiries.map((e) => ({ address: core, abi: basis === "fees" ? v08Abi : v07StatsAbi, functionName: "marketStats", args: [market!.id, BigInt(e)] }) as const),
      ]);
      const stats: ExpiryStats[] = expiries.map((expiry, i) => {
        const st = r[i + 1] as { volume: bigint; fees?: bigint; bad: boolean };
        return { expiry, volume: st.volume, fees: st.fees ?? 0n, bad: st.bad };
      });
      return { basis, threshold: r[0] as bigint, stats };
    },
  });
}

export type GridView = { anchor: number; period: number; batchInterval: number; maxExpiries: number; strikeSigDigits: number };

/** The deploy-time grid (expiry anchor and period, batch interval, strike digits). */
export function useGrid() {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["grid", chainId],
    enabled: ready,
    staleTime: Infinity,
    queryFn: async (): Promise<GridView> => {
      const g = (await client!.readContract({ address: deployment!.confluere, abi: confluereAbi, functionName: "grid" })) as any;
      return {
        anchor: Number(g.anchor),
        period: Number(g.period),
        batchInterval: Number(g.batchInterval),
        maxExpiries: Number(g.maxExpiries),
        strikeSigDigits: Number(g.strikeSigDigits),
      };
    },
  });
}

const erc4626Abi = parseAbi(["function convertToShares(uint256 assets) view returns (uint256)"]);
const wstEthAbi = parseAbi(["function getWstETHByStETH(uint256 stETHAmount) view returns (uint256)"]);

/**
 * ERC-4626 `convertToShares(assets)` of a token (the loop's LST staking rate); for Lido's wstETH (Sepolia), which is no
 * vault, `getWstETHByStETH(assets)` (stETH ≈ ETH 1:1). Null when the token is neither.
 */
export function useConvertToShares(token: Address | undefined, assets: bigint | undefined) {
  const { chainId, client } = useChainCtx();
  return useQuery({
    queryKey: ["convert-to-shares", chainId, token, assets?.toString()],
    enabled: !!client && !!token && assets !== undefined && assets > 0n,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        return (await client!.readContract({ address: token!, abi: erc4626Abi, functionName: "convertToShares", args: [assets!] })) as bigint;
      } catch {
        try {
          return (await client!.readContract({ address: token!, abi: wstEthAbi, functionName: "getWstETHByStETH", args: [assets!] })) as bigint;
        } catch {
          return null;
        }
      }
    },
  });
}

/** The core's minimum order notional per quote token (valued at K). */
export function useMinNotional(quote: Address | undefined) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["min-notional", chainId, quote],
    enabled: ready && !!quote,
    staleTime: 60_000,
    queryFn: async () => (await client!.readContract({ address: deployment!.confluere, abi: confluereAbi, functionName: "minNotional", args: [quote!] })) as bigint,
  });
}

/** Status of a pool id (0 = does not exist): the create wizard's existence check. */
export function usePoolStatus(id: Hex | undefined) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["pool-status", chainId, id],
    enabled: ready && !!id,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async () => {
      const v = (await client!.readContract({ address: deployment!.confluere, abi: confluereAbi, functionName: "pool", args: [id!] })) as any;
      return Number(v.status) as Status;
    },
  });
}

/** ERC-20 wrapper clone of an ERC-6909 id (zero address until someone creates it). */
export function useWrapper(id: bigint | undefined) {
  const { chainId, client, deployment, ready } = useChainCtx();
  return useQuery({
    queryKey: ["wrapper", chainId, id?.toString()],
    enabled: ready && id !== undefined,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async () =>
      (await client!.readContract({ address: deployment!.wrapperFactory, abi: erc6909WrapperFactoryAbi, functionName: "wrapperOf", args: [id!] })) as Address,
  });
}

/** Flash-loan capacity per token: whatever the core holds. */
export function useMaxFlashLoan(tokens: Address[]) {
  const { chainId, client, deployment, ready } = useChainCtx();
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase() as Address))].sort();
  return useQuery({
    queryKey: ["max-flash", chainId, uniq],
    enabled: ready && uniq.length > 0,
    refetchInterval: REFRESH_MS * 4,
    queryFn: async () => {
      const r = await readMany(client!, uniq.map((t) => ({ address: deployment!.confluere, abi: confluereAbi, functionName: "maxFlashLoan", args: [t] }) as const));
      return Object.fromEntries(uniq.map((t, i) => [t, r[i] as bigint])) as Record<string, bigint>;
    },
  });
}

/** Token metadata lookup in a useTokens map. */
export const tokenOf = (map: Record<string, Token> | undefined, a: string | undefined): Token | undefined => (a ? map?.[a.toLowerCase()] : undefined);

