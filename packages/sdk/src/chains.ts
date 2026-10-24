import { anvil, hyperEvm, hyperliquidEvmTestnet, mainnet, monad, monadTestnet, sepolia } from "viem/chains";
import type { Chain } from "viem";

/**
 * Chains in the core's constructor table. Monad and HyperEVM share one CREATE2 address; Ethereum (Sepolia, mainnet)
 * rows were added later, which changes the core's init code, so a Sepolia core has its own address until Monad and
 * HyperEVM are redeployed with the same table (docs/IMPLEMENTATION_NOTES.md). A chain listed here may have no
 * deployment yet: `deployments[id]` is then undefined (Sepolia until deployments/sepolia.json exists).
 */
export const supportedChains = [
  monadTestnet,
  hyperliquidEvmTestnet,
  sepolia,
  monad,
  hyperEvm,
  mainnet,
  anvil,
] as const satisfies readonly Chain[];

export const chainById = (id: number): Chain | undefined => supportedChains.find((c) => c.id === id);

/** Official HyperEVM RPC has no WebSocket: keepers and indexers poll. */
export const pollingOnly = (id: number): boolean => id === hyperEvm.id || id === hyperliquidEvmTestnet.id;

/**
 * Widest block range one eth_getLogs call may cover on the chain's public RPC: Monad's public endpoints reject
 * anything above 100 blocks, HyperEVM's above 1,000 (and rate-limit bursts); anvil accepts far more.
 * Ethereum (Sepolia, mainnet): viem's default RPC (thirdweb) rejects more than 1,000 blocks. publicnode accepts
 * 10,000 but keeps only about the last 10,000 blocks of logs ("pruned history unavailable", measured 2026-10-23), so a
 * scan from deployBlock needs an RPC with full log history; 1,000 fits both. At 12 s slots that is 3.3 h per request,
 * 8 requests a day.
 */
export function logRange(chainId: number): bigint {
  if (chainId === 143 || chainId === 10143) return 100n;
  if (chainId === 999 || chainId === 998) return 1000n;
  if (chainId === 1 || chainId === 11155111) return 1000n;
  return 5000n;
}
