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

export function loadConfig(env = process.env): Config {
  const chainId = Number(env.CHAIN_ID ?? "31337");
  const chain = chainById(chainId);
  if (!chain) throw new Error(`unsupported chain ${chainId}`);
  const deployment = deployments[chainId];
  if (!deployment) throw new Error(`no deployment for chain ${chainId}; run the deploy script and pnpm codegen`);
  return {
    chain,
    rpcUrl: env.RPC_URL ?? chain.rpcUrls.default.http[0]!,
    privateKey: req(env, "PRIVATE_KEY") as Hex,
    deployment,
    // HyperEVM's public RPC allows about 100 requests a minute per IP and has no WebSocket: poll slower there.
    pollMs: Number(env.POLL_MS ?? (pollingOnly(chain.id) ? 15_000 : 3_000)),
    settleDelayS: Number(env.SETTLE_DELAY_S ?? 5),
    settleEmpty: env.SETTLE_EMPTY === "1",
    settleTouchedOnly: env.SETTLE_TOUCHED_ONLY === "1",
    pokeLeadS: Number(env.POKE_LEAD_S ?? 60),
    closeMaxBids: BigInt(env.CLOSE_MAX_BIDS ?? 16),
    hintPort: Number(env.HINT_PORT ?? 8787),
    logChunk: logChunk(env.LOG_CHUNK, chain.id),
  };
}

/** getLogs range: LOG_CHUNK may narrow the chain's public-RPC cap (SDK logRange) but never widen it. */
function logChunk(raw: string | undefined, chainId: number): bigint {
  const cap = logRange(chainId);
  if (!raw) return cap;
  const n = BigInt(raw);
  if (n < 1n) throw new Error(`LOG_CHUNK must be at least 1, got ${raw}`);
  return n < cap ? n : cap;
}
