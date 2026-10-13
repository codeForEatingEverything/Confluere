/**
 * Chain registry (pure, no React): which networks the app serves, their RPCs, deployments and display names.
 * Every data path looks its chain up here by id; nothing reads a build-time "the chain" constant.
 *
 * - HyperEVM testnet (998) and Monad testnet (10143) are always on; anvil (31337) only with NEXT_PUBLIC_ENABLE_ANVIL=1.
 * - Default read chain: NEXT_PUBLIC_DEFAULT_CHAIN_ID, else 998 (it has live graduated markets).
 * - RPC per chain: NEXT_PUBLIC_RPC_URL_<id> overrides the primary; HyperEVM defaults to Chainlink's public endpoint
 *   (the official one rate-limits per IP), with the official endpoint as a fallback. Multicall3 exists on both
 *   testnets (eth_getCode verified 2026-10-12), so reads batch into one eth_call.
 */
import { deployments, type Deployment } from "@confluere/sdk";
import { anvil, hyperliquidEvmTestnet, monadTestnet } from "viem/chains";
import type { Chain } from "viem";
import { isDemo } from "./demo/mode";
import { demoDeploymentOf } from "./demo/deployments";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const HYPER_TESTNET = 998;
export const MONAD_TESTNET = 10143;
export const ANVIL = 31337;

const hyperTestnet: Chain = {
  ...hyperliquidEvmTestnet,
  contracts: { ...hyperliquidEvmTestnet.contracts, multicall3: { address: MULTICALL3 } },
  // the official Hyperliquid testnet explorer covers HyperEVM addresses and transactions (/address/…, /tx/…); the
  // former Purrsec fallback is gone (404)
  blockExplorers: { default: { name: "Hyperliquid Explorer", url: "https://app.hyperliquid-testnet.xyz/explorer" } },
};

export type ChainMeta = {
  id: number;
  chain: Chain;
  /** Short name for the network switcher ("HyperEVM", "Monad"). */
  name: string;
  /** Full name ("HyperEVM testnet"). */
  label: string;
  /** Gas coin symbol. */
  native: string;
  testnet: boolean;
  /** URL slug (`?chain=hyperevm`), so every link opens on the network it was made on. */
  slug: string;
  /** Primary RPC first, then fallbacks. */
  rpcs: string[];
};

const env = (k: string): string | undefined => {
  // Next inlines NEXT_PUBLIC_* only for literal property access, so each key is spelled out below.
  const v = ENV[k];
  return v && v.trim() ? v.trim() : undefined;
};

const ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_RPC_URL_998: process.env.NEXT_PUBLIC_RPC_URL_998,
  NEXT_PUBLIC_RPC_URL_10143: process.env.NEXT_PUBLIC_RPC_URL_10143,
  NEXT_PUBLIC_RPC_URL_31337: process.env.NEXT_PUBLIC_RPC_URL_31337,
  NEXT_PUBLIC_ENABLE_ANVIL: process.env.NEXT_PUBLIC_ENABLE_ANVIL,
  NEXT_PUBLIC_DEFAULT_CHAIN_ID: process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID,
};

const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

export const CHAINLINK_HYPER_TESTNET_RPC = "https://rpcs.chain.link/hyperevm/testnet";

const ALL: ChainMeta[] = [
  {
    id: HYPER_TESTNET,
    chain: hyperTestnet,
    name: "HyperEVM",
    label: "HyperEVM testnet",
    native: "HYPE",
    testnet: true,
    slug: "hyperevm",
    rpcs: uniq([env("NEXT_PUBLIC_RPC_URL_998"), CHAINLINK_HYPER_TESTNET_RPC, "https://rpc.hyperliquid-testnet.xyz/evm"]),
  },
  {
    id: MONAD_TESTNET,
    chain: monadTestnet,
    name: "Monad",
    label: "Monad testnet",
    native: "MON",
    testnet: true,
    slug: "monad",
    rpcs: uniq([env("NEXT_PUBLIC_RPC_URL_10143"), "https://testnet-rpc.monad.xyz"]),
  },
  {
    id: ANVIL,
    chain: anvil,
    name: "Anvil",
    label: "Local anvil",
    native: "ETH",
    testnet: true,
    slug: "anvil",
    rpcs: uniq([env("NEXT_PUBLIC_RPC_URL_31337"), "http://127.0.0.1:8545"]),
  },
];

export const ANVIL_ENABLED = env("NEXT_PUBLIC_ENABLE_ANVIL") === "1";

/** Networks this build serves, in switcher order. */
export const ENABLED: ChainMeta[] = ALL.filter((c) => c.id !== ANVIL || ANVIL_ENABLED);
export const ENABLED_IDS: number[] = ENABLED.map((c) => c.id);
export const ENABLED_CHAINS = ENABLED.map((c) => c.chain) as [Chain, ...Chain[]];

export const isEnabledChain = (id: number | undefined | null): id is number => id != null && ENABLED_IDS.includes(id);

const wanted = Number(env("NEXT_PUBLIC_DEFAULT_CHAIN_ID") ?? HYPER_TESTNET);
export const DEFAULT_CHAIN_ID: number = isEnabledChain(wanted) ? wanted : HYPER_TESTNET;

/** Registry entry of an enabled chain (falls back to the default chain for anything else). */
export function chainMeta(id: number): ChainMeta {
  return ENABLED.find((c) => c.id === id) ?? ENABLED.find((c) => c.id === DEFAULT_CHAIN_ID)!;
}

/** Same as chainMeta but over every known chain, enabled or not (server routes accept anvil only when enabled). */
export const knownChainMeta = (id: number): ChainMeta | undefined => ALL.find((c) => c.id === id);

/** The deployment of a network; in demo mode (lib/demo) the sample deployment the demo runs on. */
export const deploymentOf = (id: number): Deployment | undefined => (isDemo() ? demoDeploymentOf(id) : deployments[id]);

export const rpcUrlsOf = (id: number): string[] => knownChainMeta(id)?.rpcs ?? [];

/** Explorer link for a transaction on `chainId` (undefined when the chain has no explorer, e.g. anvil). */
export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  if (isDemo()) return undefined; // demo "transactions" are signed messages: nothing to look up
  const u = knownChainMeta(chainId)?.chain.blockExplorers?.default.url;
  return u ? `${u}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(chainId: number, address: string): string | undefined {
  const u = knownChainMeta(chainId)?.chain.blockExplorers?.default.url;
  return u ? `${u}/address/${address}` : undefined;
}

/** Real launch tokens of the deployment (mock `tokens` on anvil, else those listed under `pools`). */
export function launchTokensOf(id: number): { lst?: `0x${string}`; native?: `0x${string}`; usdc?: `0x${string}` } {
  const d = deploymentOf(id);
  const t = d?.tokens ?? d?.pools;
  const nz = (a?: `0x${string}`) => (a && !/^0x0{40}$/i.test(a) ? a : undefined);
  return { lst: nz(t?.lst), native: nz(t?.native), usdc: nz(t?.usdc) };
}

/** Chain id for a `?chain=` slug (or a numeric id), when this build serves it. */
export function chainIdFromSlug(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const hit = ENABLED.find((c) => c.slug === v.toLowerCase() || String(c.id) === v);
  return hit?.id;
}
