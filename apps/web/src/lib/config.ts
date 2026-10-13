/**
 * Compatibility exports. The app is multi-chain at runtime: new code reads the chain from `useActiveChain()`
 * (lib/activeChain) and looks deployments up with `deploymentOf(chainId)` (lib/chains).
 *
 * CHAIN_ID / chain / deployment / RPC_URL / IS_TEST below are ES-module live bindings that follow the active chain
 * (lib/activeChain updates them on every switch), so older components keep rendering the current network. Data code
 * must not use them: query keys and reads take the chain from the hook.
 */
import type { Deployment } from "@confluere/sdk";
import type { Chain } from "viem";
import { DEFAULT_CHAIN_ID, chainMeta, deploymentOf } from "./chains";

/** @deprecated use useActiveChain().chainId */
export let CHAIN_ID: number = DEFAULT_CHAIN_ID;
/** @deprecated use useActiveChain().chain */
export let chain: Chain = chainMeta(DEFAULT_CHAIN_ID).chain;
/** @deprecated use useActiveChain().deployment */
export let deployment: Deployment | undefined = deploymentOf(DEFAULT_CHAIN_ID);
/** @deprecated use chainMeta(id).rpcs[0] */
export let RPC_URL: string = chainMeta(DEFAULT_CHAIN_ID).rpcs[0]!;
/** Faucet minting only exists on mock tokens (testnets and local demos). @deprecated use chainMeta(id).testnet */
export let IS_TEST: boolean = chainMeta(DEFAULT_CHAIN_ID).testnet;

export const PROJECT_ID = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
export const REF_PRICE_URL = process.env.NEXT_PUBLIC_REF_PRICE_URL ?? "";

/** Called by lib/activeChain only. */
export function _setLegacyChain(id: number) {
  const m = chainMeta(id);
  CHAIN_ID = m.id;
  chain = m.chain;
  deployment = deploymentOf(m.id);
  RPC_URL = m.rpcs[0]!;
  IS_TEST = m.testnet;
}
