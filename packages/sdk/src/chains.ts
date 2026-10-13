import { anvil, hyperEvm, hyperliquidEvmTestnet, monad, monadTestnet } from "viem/chains";
import type { Chain } from "viem";

/** Chains in the core's constructor table. Same CREATE2 addresses on all of them. */
export const supportedChains = [monadTestnet, hyperliquidEvmTestnet, monad, hyperEvm, anvil] as const satisfies readonly Chain[];

export const chainById = (id: number): Chain | undefined => supportedChains.find((c) => c.id === id);

/** Official HyperEVM RPC has no WebSocket: keepers and indexers poll. */
export const pollingOnly = (id: number): boolean => id === hyperEvm.id || id === hyperliquidEvmTestnet.id;

/**
 * Widest block range one eth_getLogs call may cover on the chain's public RPC: Monad's public endpoints reject
 * anything above 100 blocks, HyperEVM's above 1,000 (and rate-limit bursts); anvil accepts far more.
 */
export function logRange(chainId: number): bigint {
  if (chainId === 143 || chainId === 10143) return 100n;
  if (chainId === 999 || chainId === 998) return 1000n;
  return 5000n;
}
