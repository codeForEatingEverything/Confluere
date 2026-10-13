import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildConfig,
  chunkRanges,
  livePools,
  readStatuses,
  scanPoolIds,
  STATUS_CLOSED,
  vaultsOf,
  withRetry,
} from "../scripts/sync-config.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const id = (b: string) => `0x${b.repeat(32)}`;
const noWait = async () => {};

describe("sync-config", () => {
  it("covers the scan range in inclusive chunks of at most 100 blocks", () => {
    expect(chunkRanges(1000n, 1250n, 100n)).toEqual([
      [1000n, 1099n],
      [1100n, 1199n],
      [1200n, 1250n],
    ]);
    expect(chunkRanges(5n, 5n, 100n)).toEqual([[5n, 5n]]);
    expect(chunkRanges(6n, 5n, 100n)).toEqual([]);
  });

  it("keeps pools that are Open, Window or Closing and drops Closed, unknown and duplicate ids", () => {
    const ids = [id("aa"), id("bb"), id("cc"), id("dd"), id("ee"), id("AA")];
    const status = new Map<string, number>([
      [id("aa"), 1],
      [id("bb"), STATUS_CLOSED],
      [id("cc"), 2],
      [id("dd"), 0],
      [id("ee"), 3],
    ]);
    expect(livePools(ids, status)).toEqual([id("aa"), id("cc"), id("ee")]);
  });

  it("takes receiver and non-zero vaults from the deployment and keeps the schedule settings", () => {
    const base = {
      schedule: "5 */2 * * * *",
      chainSelectorName: "monad-testnet",
      isTestnet: true,
      receiver: "0x0000000000000000000000000000000000000001",
      pools: [id("99")],
      vaults: [],
      gasLimit: "8000000",
    };
    const deployment = {
      keeperReceiver: "0x5149637A57030b2A07463032758F542fe987EB6A",
      vaults: { a: "0x9364eE5012211f297aD1d3A50ed0b51c76EC2E0d", b: ZERO, c: "0x9364ee5012211f297ad1d3a50ed0b51c76ec2e0d" },
    };
    expect(buildConfig(base, deployment, [id("aa")])).toEqual({
      ...base,
      receiver: deployment.keeperReceiver,
      pools: [id("aa")],
      vaults: ["0x9364eE5012211f297aD1d3A50ed0b51c76EC2E0d"],
    });
    expect(() => buildConfig(base, { keeperReceiver: ZERO }, [])).toThrow(/keeperReceiver/);
  });

  it("reads the vaults of the committed monad-testnet deployment", () => {
    const d = JSON.parse(readFileSync(new URL("../../../deployments/monad-testnet.json", import.meta.url), "utf8"));
    expect(vaultsOf(d)).toHaveLength(Object.values(d.vaults).filter((v) => v !== ZERO).length);
  });

  it("scans PoolCreated chunk by chunk, retrying a rate-limited chunk", async () => {
    const calls: [bigint, bigint][] = [];
    let failed = false;
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (fromBlock === 100n && !failed) {
          failed = true;
          throw new Error("429 Too Many Requests");
        }
        calls.push([fromBlock, toBlock]);
        return fromBlock === 100n ? [{ args: { poolId: id("aa") } }, { args: { poolId: id("bb") } }] : [];
      },
    };
    const ids = await scanPoolIds(client, ZERO, 0n, 250n, { chunk: 100n, wait: noWait });
    expect(ids).toEqual([id("aa"), id("bb")]);
    expect(calls).toEqual([
      [0n, 99n],
      [100n, 199n],
      [200n, 250n],
    ]);
  });

  it("reads each pool's status keyed by lower-cased id", async () => {
    const client = {
      readContract: async ({ args }: { args: [string] }) => [{}, args[0] === id("AA") ? 4 : 1],
    };
    const s = await readStatuses(client, ZERO, [id("AA"), id("bb")], { wait: noWait });
    expect(s.get(id("aa"))).toBe(4);
    expect(s.get(id("bb"))).toBe(1);
  });

  it("gives up after the last retry", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("down");
        },
        { tries: 3, wait: noWait },
      ),
    ).rejects.toThrow("down");
    expect(n).toBe(3);
  });
});
