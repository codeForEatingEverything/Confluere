import { describe, expect, it } from "vitest";
import type { Deployment } from "@confluere/sdk";
import { loadConfig } from "../src/config.js";

// anvil key 0: test-only
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("loadConfig", () => {
  it("clamps LOG_CHUNK to the chain's public-RPC getLogs cap", () => {
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "10143", LOG_CHUNK: "2000" }).logChunk).toBe(100n);
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "998", LOG_CHUNK: "2000" }).logChunk).toBe(1000n);
  });
  it("uses the cap when LOG_CHUNK is unset, and a smaller value as given", () => {
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "10143" }).logChunk).toBe(100n);
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "998", LOG_CHUNK: "250" }).logChunk).toBe(250n);
  });
  it("rejects a zero LOG_CHUNK (the scan loop would never advance)", () => {
    expect(() => loadConfig({ PRIVATE_KEY, CHAIN_ID: "10143", LOG_CHUNK: "0" })).toThrow(/LOG_CHUNK/);
  });
  it("polls slower by default on HyperEVM, whose public RPC allows ~100 requests a minute", () => {
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "998" }).pollMs).toBe(15_000);
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "10143" }).pollMs).toBe(3_000);
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "998", POLL_MS: "5000" }).pollMs).toBe(5_000);
  });
  it("keeps Sepolia: 1,000-block getLogs, 6 s polls, a clear error until it is deployed", () => {
    const sepolia = { 11155111: { chainId: 11155111, deployBlock: 1 } as Deployment };
    const cfg = loadConfig({ PRIVATE_KEY, CHAIN_ID: "11155111" }, sepolia);
    expect(cfg.chain.id).toBe(11155111);
    expect(cfg.logChunk).toBe(1000n);
    expect(cfg.pollMs).toBe(6_000);
    expect(cfg.rpcUrl).toMatch(/^https:/);
    expect(loadConfig({ PRIVATE_KEY, CHAIN_ID: "11155111", LOG_CHUNK: "5000" }, sepolia).logChunk).toBe(1000n);
    expect(() => loadConfig({ PRIVATE_KEY, CHAIN_ID: "11155111" }, {})).toThrow(/no deployment for chain 11155111/);
    expect(() => loadConfig({ PRIVATE_KEY, CHAIN_ID: "11155420" })).toThrow(/unsupported chain/);
  });
  it("reads PRIVATE_KEY from the env it is given", () => {
    expect(() => loadConfig({ CHAIN_ID: "10143" })).toThrow(/PRIVATE_KEY/);
  });
});
