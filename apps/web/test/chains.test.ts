/** Chain registry: enabled networks, default, RPC order, Multicall3, explorers, launch tokens. */
import { describe, expect, it } from "vitest";
import {
  CHAINLINK_HYPER_TESTNET_RPC,
  DEFAULT_CHAIN_ID,
  ENABLED_IDS,
  MULTICALL3,
  chainMeta,
  deploymentOf,
  explorerTxUrl,
  isEnabledChain,
  launchTokensOf,
  rpcUrlsOf,
} from "../src/lib/chains";

describe("chains", () => {
  it("serves HyperEVM and Monad testnets; anvil only when enabled", () => {
    expect(ENABLED_IDS).toEqual([998, 10143]);
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

  it("both testnets batch reads through Multicall3", () => {
    expect(chainMeta(998).chain.contracts?.multicall3?.address).toBe(MULTICALL3);
    expect(chainMeta(10143).chain.contracts?.multicall3?.address).toBe(MULTICALL3);
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
