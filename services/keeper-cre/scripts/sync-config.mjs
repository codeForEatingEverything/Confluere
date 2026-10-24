#!/usr/bin/env node
/**
 * Rebuilds config.staging.json from deployments/<chain>.json and the chain itself:
 *   receiver = keeperReceiver, vaults = the non-zero vault addresses,
 *   pools    = every pool the core created (PoolCreated logs from deployBlock) that is not Closed.
 *
 * The workflow carries ids only, so this is the step that keeps later expiries (opened by CreatePools.s.sol or the
 * /create wizard) in the CRE tick. Re-run it after opening pools. Read-only: no transaction is sent.
 *
 * One workflow config per chain (CRE_CHAINS): Monad testnet writes config.staging.json (target staging-settings),
 * Ethereum Sepolia config.sepolia.json (target sepolia-settings). A chain without deployments/<name>.json yet is
 * skipped with a message and exit code 0, so deploy scripts can call this before the chain is deployed.
 *
 * Env: DEPLOYMENT (monad-testnet | sepolia, default monad-testnet), RPC_URL (default: the chain's row below),
 *      SKIP_SCAN=1 (use deployments pools.poolIds instead of scanning logs), CHUNK (default: the chain's eth_getLogs
 *      cap, 100 blocks on Monad testnet, 1,000 on Sepolia), DELAY_MS (pause between requests, default 150, for the
 *      public RPC rate limit), CRE_CONFIG (config file to write, relative to this package, default: the chain's row).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Chains the CRE workflow targets, keyed by the deployments/<name>.json basename. `chainSelectorName` is the CRE / CCIP
 * chain-selector name getNetwork() resolves (@chainlink/cre-sdk dist/generated/chain-selectors). The forwarders
 * (CRE docs, Forwarder Directory) are informational: KeeperReceiver accepts onReport from anyone, so neither address
 * is configured at deploy time. `mock` is the MockKeystoneForwarder `cre workflow simulate --broadcast` writes
 * through, `keystone` the KeystoneForwarder of a deployed workflow.
 * Sepolia RPC: viem's default (thirdweb) keeps the full log history but caps eth_getLogs at 1,000 blocks; publicnode
 * accepts wider ranges but prunes logs older than about 10,000 blocks, too short for a scan from deployBlock.
 * `gasLimit` is the report's gas for a chain's first config. Sepolia prices new storage far higher (Amsterdam): on an
 * anvil fork (2026-10-23) a tick over 24 pools that first settled a new expiry's 6 seeded pools used 8.4M gas, the first
 * settlement of 18 freshly seeded pools 24.7M, a steady-state tick of 18 pools 5.0M. KeeperReceiver catches a pool that
 * runs out of gas, but the ones after it then wait for the next tick, so Sepolia gets 30M (its transactions go up to
 * ~57M, blocks are ~200M). An existing config keeps its own gasLimit.
 */
export const CRE_CHAINS = {
  "monad-testnet": {
    chainId: 10143,
    chainSelectorName: "monad-testnet",
    isTestnet: true,
    rpc: "https://testnet-rpc.monad.xyz",
    chunk: 100n,
    config: "config.staging.json",
    target: "staging-settings",
    gasLimit: "8000000",
    forwarder: { mock: "0xB9F79d863261869B234c481D1f9A7af84AeAd192", keystone: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" },
  },
  sepolia: {
    chainId: 11155111,
    chainSelectorName: "ethereum-testnet-sepolia",
    isTestnet: true,
    rpc: "https://11155111.rpc.thirdweb.com",
    chunk: 1000n,
    config: "config.sepolia.json",
    target: "sepolia-settings",
    gasLimit: "30000000",
    forwarder: { mock: "0x15fC6ae953E024d975e77382eEeC56A9101f9F88", keystone: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" },
  },
};

/** The CRE_CHAINS row of a deployments basename; anything else is not a CRE target. */
export function creChain(name) {
  if (!Object.hasOwn(CRE_CHAINS, name)) {
    throw new Error(`${name} is not a CRE target; use one of ${Object.keys(CRE_CHAINS).join(", ")}`);
  }
  return CRE_CHAINS[name];
}

/**
 * Six-field cron (with seconds) firing 5 s after every batch boundary of the deployment's grid: second 5 of every 2nd
 * minute for the 120 s grid. Batch intervals that do not divide an hour or a day evenly have no such cron.
 */
export function scheduleFor(batchInterval) {
  const s = Number(batchInterval);
  const m = s / 60;
  const h = s / 3600;
  if (Number.isInteger(m) && m >= 1 && m < 60 && 60 % m === 0) return m === 1 ? "5 * * * * *" : `5 */${m} * * * *`;
  if (Number.isInteger(h) && h >= 1 && h <= 24 && 24 % h === 0) return h === 1 ? "5 0 * * * *" : h === 24 ? "5 0 0 * * *" : `5 0 */${h} * * *`;
  throw new Error(`batchInterval ${batchInterval} s has no cron schedule; set "schedule" in the config by hand`);
}

/** Starting config for a chain whose config file does not exist yet (its first sync). */
export function defaultBase(row, deployment) {
  return {
    schedule: scheduleFor(deployment.batchInterval),
    chainSelectorName: row.chainSelectorName,
    isTestnet: row.isTestnet,
    receiver: ZERO,
    pools: [],
    vaults: [],
    gasLimit: row.gasLimit,
  };
}
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

/**
 * New workflow config: keeps schedule / gas settings from `base`, replaces receiver, pools and vaults. With `row`
 * (a CRE_CHAINS entry) the chain selector comes from the row and the deployment must be on that chain, so a config
 * can never send one chain's ids to another chain's forwarder.
 */
export function buildConfig(base, deployment, pools, row) {
  if (!deployment.keeperReceiver || deployment.keeperReceiver.toLowerCase() === ZERO) {
    throw new Error("deployment has no keeperReceiver");
  }
  const chain = {};
  if (row) {
    if (deployment.chainId !== row.chainId) {
      throw new Error(`deployment is on chain ${deployment.chainId}, not ${row.chainSelectorName} (${row.chainId})`);
    }
    chain.chainSelectorName = row.chainSelectorName;
    chain.isTestnet = row.isTestnet;
  }
  return { ...base, ...chain, receiver: deployment.keeperReceiver, pools, vaults: vaultsOf(deployment) };
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
  const row = creChain(chain);
  const rpc = process.env.RPC_URL ?? row.rpc;
  const chunk = BigInt(process.env.CHUNK ?? row.chunk);
  const delayMs = Number(process.env.DELAY_MS ?? "150");
  const skipScan = process.env.SKIP_SCAN === "1";
  const deploymentPath = resolve(pkg, "../../deployments", `${chain}.json`);
  const configPath = resolve(pkg, process.env.CRE_CONFIG ?? row.config);
  const log = (m) => console.error(`[sync-config] ${m}`);

  if (!existsSync(deploymentPath)) {
    log(`no deployments/${chain}.json yet: ${configPath} not touched (deploy ${chain} first)`);
    return;
  }
  const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const base = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : defaultBase(row, deployment);
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 30_000 }) });

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
  const config = buildConfig(base, deployment, pools, row);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  log(`wrote ${configPath} (target ${row.target}): receiver ${config.receiver}, ${pools.length}/${ids.length} pools not Closed, ${config.vaults.length} vaults`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
