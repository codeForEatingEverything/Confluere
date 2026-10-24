import { deployments, chainById, type Deployment, logRange, pollingOnly } from "@confluere/sdk";
import type { Chain, Hex } from "viem";

export type Config = {
  chain: Chain;
  rpcUrl: string;
  privateKey: Hex;
  deployment: Deployment;
  pollMs: number;
  settleDelayS: number;
  settleEmpty: boolean; // SETTLE_EMPTY=1 settles every due batch, even when the whole book is empty
  settleTouchedOnly: boolean; // SETTLE_TOUCHED_ONLY=1 (gas budget mode): settle only pools that got new orders since their last settle
  pokeLeadS: number;
  closeMaxBids: bigint;
  hintPort: number;
  logChunk: bigint;
};

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/** `known` defaults to the SDK's deployments; a chain the SDK supports but nobody deployed to yet (Sepolia before
 * deployments/sepolia.json exists) stops here with a clear message instead of a missing-address error later. */
export function loadConfig(env = process.env, known: Record<number, Deployment> = deployments): Config {
  const chainId = Number(env.CHAIN_ID ?? "31337");
  const chain = chainById(chainId);
  if (!chain) throw new Error(`unsupported chain ${chainId}`);
  const deployment = known[chainId];
  if (!deployment) throw new Error(`no deployment for chain ${chainId}; run the deploy script and pnpm codegen`);
  return {
    chain,
    rpcUrl: env.RPC_URL ?? chain.rpcUrls.default.http[0]!,
    privateKey: req(env, "PRIVATE_KEY") as Hex,
    deployment,
    pollMs: Number(env.POLL_MS ?? defaultPollMs(chain.id)),
    settleDelayS: Number(env.SETTLE_DELAY_S ?? 5),
    settleEmpty: env.SETTLE_EMPTY === "1",
    settleTouchedOnly: env.SETTLE_TOUCHED_ONLY === "1",
    pokeLeadS: Number(env.POKE_LEAD_S ?? 60),
    closeMaxBids: BigInt(env.CLOSE_MAX_BIDS ?? 16),
    hintPort: Number(env.HINT_PORT ?? 8787),
    logChunk: logChunk(env.LOG_CHUNK, chain.id),
  };
}

/**
 * HyperEVM's public RPC allows about 100 requests a minute per IP and has no WebSocket: poll slower there. Ethereum
 * (Sepolia, mainnet) makes a block every 12 s, so polling faster than every 6 s only spends the RPC's rate limit.
 */
export function defaultPollMs(chainId: number): number {
  if (pollingOnly(chainId)) return 15_000;
  if (chainId === 1 || chainId === 11155111) return 6_000;
  return 3_000;
}

/** getLogs range: LOG_CHUNK may narrow the chain's public-RPC cap (SDK logRange) but never widen it. */
function logChunk(raw: string | undefined, chainId: number): bigint {
  const cap = logRange(chainId);
  if (!raw) return cap;
  const n = BigInt(raw);
  if (n < 1n) throw new Error(`LOG_CHUNK must be at least 1, got ${raw}`);
  return n < cap ? n : cap;
}
