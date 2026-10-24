/** Chain registry: enabled networks, default, RPC order, Multicall3, explorers, launch tokens. */
import { describe, expect, it } from "vitest";
import { deployments } from "@confluere/sdk";
import {
  CHAINLINK_HYPER_TESTNET_RPC,
  DEFAULT_CHAIN_ID,
  ENABLED_IDS,
  MULTICALL3,
  PUBLICNODE_SEPOLIA_RPC,
  chainIdFromSlug,
  chainMeta,
  deploymentOf,
  explorerTxUrl,
  isEnabledChain,
  launchTokensOf,
  rpcUrlsOf,
} from "../src/lib/chains";

describe("chains", () => {
  it("serves HyperEVM and Monad testnets and Sepolia; anvil only when enabled", () => {
    expect(ENABLED_IDS).toEqual([998, 10143, 11155111]);
    expect(isEnabledChain(31337)).toBe(false);
    expect(isEnabledChain(undefined)).toBe(false);
  });

  it("defaults to HyperEVM testnet", () => {
    expect(DEFAULT_CHAIN_ID).toBe(998);
    expect(chainMeta(12345).id).toBe(998);
  });

  it("HyperEVM reads through Chainlink first, the official RPC second", () => {
    expect(rpcUrlsOf(998)).toEqual([CHAINLINK_HYPER_TESTNET_RPC, "https://rpc.hyperliquid-testnet.xyz/evm"]);
    expect(rpcUrlsOf(10143)[0]).toBe("https://testnet-rpc.monad.xyz");
  });

  it("every served testnet batches reads through Multicall3", () => {
    expect(chainMeta(998).chain.contracts?.multicall3?.address).toBe(MULTICALL3);
    expect(chainMeta(10143).chain.contracts?.multicall3?.address).toBe(MULTICALL3);
    expect(chainMeta(11155111).chain.contracts?.multicall3?.address.toLowerCase()).toBe(MULTICALL3.toLowerCase());
  });

  it("Sepolia: ETH, a ?chain=sepolia slug, publicnode first then viem's default RPC, Etherscan links", () => {
    const m = chainMeta(11155111);
    expect(m).toMatchObject({ id: 11155111, name: "Sepolia", label: "Sepolia testnet", native: "ETH", testnet: true, slug: "sepolia" });
    expect(chainIdFromSlug("sepolia")).toBe(11155111);
    expect(rpcUrlsOf(11155111)).toEqual([PUBLICNODE_SEPOLIA_RPC, "https://11155111.rpc.thirdweb.com"]);
    expect(explorerTxUrl(11155111, "0xab")).toBe("https://sepolia.etherscan.io/tx/0xab");
  });

  // holds until deployments/sepolia.json exists; afterwards the SDK's deployment is the answer
  it.skipIf(!!deployments[11155111])("Sepolia is served before it is deployed: no deployment and no launch tokens until the SDK has one", () => {
    expect(isEnabledChain(11155111)).toBe(true);
    expect(deploymentOf(11155111)).toBeUndefined();
    expect(launchTokensOf(11155111)).toEqual({ lst: undefined, native: undefined, usdc: undefined });
  });

  it("same core on both testnets, per-chain launch tokens", () => {
    expect(deploymentOf(998)!.confluere).toBe(deploymentOf(10143)!.confluere);
    expect(launchTokensOf(998)).toEqual({ lst: undefined, native: "0x5555555555555555555555555555555555555555", usdc: "0x2B3370eE501B4a559b57D449569354196457D8Ab" });
    expect(launchTokensOf(10143).lst).toBe("0x282BdDFF5e58793AcAb65438b257Dbd15A8745C9");
  });

  it("explorer links per chain", () => {
    expect(explorerTxUrl(10143, "0xab")).toBe("https://testnet.monadexplorer.com/tx/0xab");
    expect(explorerTxUrl(31337, "0xab")).toBeUndefined();
  });
});
