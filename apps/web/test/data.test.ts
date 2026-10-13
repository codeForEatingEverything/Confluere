import { describe, expect, it } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { anvil } from "viem/chains";
import { deployments, Status } from "@confluere/sdk";
import { readPools } from "../src/lib/data";
import { readMany } from "../src/lib/many";

// Runs the same read path the browser uses, against the local anvil deployment (no multicall3 there).
const d = deployments[31337];
const up = await fetch("http://127.0.0.1:8545", { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}', headers: { "content-type": "application/json" } })
  .then(() => true)
  .catch(() => false);

describe.runIf(d?.pools && up)("web data layer on anvil", () => {
  const client = createPublicClient({ chain: anvil, transport: http() }) as PublicClient;

  it("reads every launch pool without multicall3", async () => {
    const rows = await readPools(client, d!.pools!.poolIds);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.status).toBeGreaterThanOrEqual(Status.Open);
      expect(r.strike > 0n).toBe(true);
    }
    expect(rows.some((r) => r.lastClearingPrice > 0n)).toBe(true);
  });

  it("falls back to parallel calls in order", async () => {
    const abi = [{ type: "function", name: "WINDOW_BLOCKS", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }] as const;
    const [w] = await readMany(client, [{ address: d!.confluere, abi, functionName: "WINDOW_BLOCKS" }]);
    expect(w).toBe(BigInt(d!.windowBlocks));
  });
});
