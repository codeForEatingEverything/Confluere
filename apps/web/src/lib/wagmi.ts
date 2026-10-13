import { createConfig, fallback, http, type Config, type Transport } from "wagmi";
import { injected } from "wagmi/connectors";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { ENABLED } from "./chains";
import { PROJECT_ID } from "./config";

/**
 * One transport per enabled chain: the primary RPC with JSON-RPC retries (exponential backoff, viem doubles the
 * delay per attempt), then the fallbacks. Public testnet RPCs rate-limit bursts (Monad 25 req/s, HyperEVM official
 * per IP), so reads also batch through Multicall3 (wagmi's client `batch.multicall`, both testnets have it).
 */
export function makeTransport(rpcs: string[]): Transport {
  const list = rpcs.map((u) => http(u, { retryCount: 3, retryDelay: 400, timeout: 15_000 }));
  return list.length === 1 ? list[0]! : fallback(list, { retryCount: 1 });
}

export const transports: Record<number, Transport> = Object.fromEntries(ENABLED.map((c) => [c.id, makeTransport(c.rpcs)]));

const chains = ENABLED.map((c) => c.chain) as [(typeof ENABLED)[number]["chain"], ...(typeof ENABLED)[number]["chain"][]];

// Collect the reads one render issues into one aggregate3 call (16 ms window, up to 8 KB of calldata per call).
const batch = { multicall: { batchSize: 8_192, wait: 16 } };

/** AppKit when a Reown project id is configured, otherwise a plain injected-wallet config. */
export const wagmiAdapter = PROJECT_ID
  ? new WagmiAdapter({ networks: chains, projectId: PROJECT_ID, transports, ssr: true, batch } as never)
  : undefined;

export const wagmiConfig: Config =
  wagmiAdapter?.wagmiConfig ?? createConfig({ chains, connectors: [injected()], transports, ssr: true, batch });
