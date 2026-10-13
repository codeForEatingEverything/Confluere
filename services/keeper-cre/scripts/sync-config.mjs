#!/usr/bin/env node
/**
 * Rebuilds config.staging.json from deployments/<chain>.json and the chain itself:
 *   receiver = keeperReceiver, vaults = the non-zero vault addresses,
 *   pools    = every pool the core created (PoolCreated logs from deployBlock) that is not Closed.
 *
 * The workflow carries ids only, so this is the step that keeps later expiries (opened by CreatePools.s.sol or the
 * /create wizard) in the CRE tick. Re-run it after opening pools. Read-only: no transaction is sent.
 *
 * Env: DEPLOYMENT (default monad-testnet), RPC_URL (default https://testnet-rpc.monad.xyz),
 *      SKIP_SCAN=1 (use deployments pools.poolIds instead of scanning logs), CHUNK (default 100 blocks, the
 *      Monad testnet eth_getLogs limit), DELAY_MS (pause between requests, default 150, for the public RPC rate limit).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";
/** IConfluere.Status: None, Open, Window, Closing, Closed. */
export const STATUS_NONE = 0;
export const STATUS_CLOSED = 4;

export const poolCreated = parseAbiItem(
  "event PoolCreated(bytes32 indexed poolId, (address asset, address quote, uint64 expiry, uint128 strike, uint8 kind) key, uint16 feeBps, uint16 bandBps, bytes32 indexed marketId)",
);
// Only the leading fields of IConfluere.PoolView are needed; the struct is returned by value, so the head decodes
// from the first two words (key is a static tuple, status follows it).
const poolAbi = parseAbi([
  "struct PoolKey { address asset; address quote; uint64 expiry; uint128 strike; uint8 kind; }",
  "function pool(bytes32 poolId) view returns (PoolKey key, uint8 status)",
]);

/** Inclusive [from, to] block ranges of at most `size` blocks covering [start, end]. */
export function chunkRanges(start, end, size) {
  if (size < 1n) throw new Error("chunk size must be >= 1");
  const out = [];
  for (let from = start; from <= end; from += size) {
    const to = from + size - 1n < end ? from + size - 1n : end;
    out.push([from, to]);
  }
  return out;
}

/** Non-zero vault addresses from deployments.vaults, deduplicated, in file order. */
export function vaultsOf(deployment) {
  const seen = new Set();
  const out = [];
  for (const v of Object.values(deployment.vaults ?? {})) {
    if (typeof v !== "string" || v.toLowerCase() === ZERO || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** Keeps pools the core knows (status != None) that are not Closed, preserving order and dropping duplicates. */
export function livePools(ids, statusOf) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    const k = id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const s = statusOf.get(k);
    if (s === undefined || s === STATUS_NONE || s === STATUS_CLOSED) continue;
    out.push(id);
  }
  return out;
}

/** New workflow config: keeps schedule / chain / gas settings from `base`, replaces receiver, pools and vaults. */
export function buildConfig(base, deployment, pools) {
  if (!deployment.keeperReceiver || deployment.keeperReceiver.toLowerCase() === ZERO) {
    throw new Error("deployment has no keeperReceiver");
  }
  return { ...base, receiver: deployment.keeperReceiver, pools, vaults: vaultsOf(deployment) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls `fn`, backing off exponentially on failure (public RPCs answer 429 under load). */
export async function withRetry(fn, { tries = 8, baseMs = 500, wait = sleep } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await wait(baseMs * 2 ** i);
    }
  }
}

/** PoolCreated pool ids emitted by `core` in [fromBlock, toBlock], scanned sequentially in `chunk`-block ranges. */
export async function scanPoolIds(
  client,
  core,
  fromBlock,
  toBlock,
  { chunk = 100n, delayMs = 0, log = () => {}, wait = sleep } = {},
) {
  const ids = [];
  const ranges = chunkRanges(fromBlock, toBlock, chunk);
  for (let i = 0; i < ranges.length; i++) {
    const [from, to] = ranges[i];
    const logs = await withRetry(
      () => client.getLogs({ address: core, event: poolCreated, fromBlock: from, toBlock: to }),
      { wait },
    );
    for (const l of logs) if (l.args?.poolId) ids.push(l.args.poolId);
    if (i % 500 === 0 || i === ranges.length - 1) log(`scanned ${i + 1}/${ranges.length} chunks, ${ids.length} pools`);
    if (delayMs > 0) await wait(delayMs);
  }
  return ids;
}

/** Status of each pool id (lower-cased key), read one by one so the public RPC is not flooded. */
export async function readStatuses(client, core, ids, { delayMs = 0, wait = sleep } = {}) {
  const out = new Map();
  for (const id of ids) {
    const [, status] = await withRetry(
      () => client.readContract({ address: core, abi: poolAbi, functionName: "pool", args: [id] }),
      { wait },
    );
    out.set(id.toLowerCase(), Number(status));
    if (delayMs > 0) await wait(delayMs);
  }
  return out;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = resolve(here, "..");
  const chain = process.env.DEPLOYMENT ?? "monad-testnet";
  const rpc = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
  const chunk = BigInt(process.env.CHUNK ?? "100");
  const delayMs = Number(process.env.DELAY_MS ?? "150");
  const skipScan = process.env.SKIP_SCAN === "1";
  const deploymentPath = resolve(pkg, "../../deployments", `${chain}.json`);
  const configPath = resolve(pkg, "config.staging.json");

  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const base = JSON.parse(readFileSync(configPath, "utf8"));
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 30_000 }) });
  const log = (m) => console.error(`[sync-config] ${m}`);

  let ids;
  if (skipScan) {
    ids = deployment.pools?.poolIds ?? [];
    log(`SKIP_SCAN=1: ${ids.length} pools from deployments/${chain}.json`);
  } else {
    if (deployment.deployBlock === undefined) throw new Error(`deployments/${chain}.json has no deployBlock`);
    const head = await withRetry(() => client.getBlockNumber());
    const from = BigInt(deployment.deployBlock);
    log(`scanning PoolCreated on ${deployment.confluere} from ${from} to ${head} in ${chunk}-block chunks`);
    ids = await scanPoolIds(client, deployment.confluere, from, head, { chunk, delayMs, log });
  }

  const statuses = await readStatuses(client, deployment.confluere, ids, { delayMs });
  const pools = livePools(ids, statuses);
  const config = buildConfig(base, deployment, pools);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  log(`wrote ${configPath}: receiver ${config.receiver}, ${pools.length}/${ids.length} pools not Closed, ${config.vaults.length} vaults`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
