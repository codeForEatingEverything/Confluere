import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  buildConfig,
  CRE_CHAINS,
  creChain,
  defaultBase,
  scheduleFor,
  chunkRanges,
  livePools,
  readStatuses,
  scanPoolIds,
  STATUS_CLOSED,
  STATUS_SELLING,
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

  it("keeps pools that are Open, Window, Closing or Selling and drops Closed, unknown and duplicate ids", () => {
    const ids = [id("aa"), id("bb"), id("cc"), id("dd"), id("ee"), id("ff"), id("AA")];
    const status = new Map<string, number>([
      [id("aa"), 1],
      [id("bb"), STATUS_CLOSED],
      [id("cc"), 2],
      [id("dd"), 0],
      [id("ee"), 3],
      [id("ff"), STATUS_SELLING],
    ]);
    expect(STATUS_CLOSED).toBe(5);
    expect(livePools(ids, status)).toEqual([id("aa"), id("cc"), id("ee"), id("ff")]);
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

  it("targets Monad testnet and Sepolia, each with its own config file and getLogs cap", () => {
    expect(creChain("monad-testnet")).toMatchObject({ chainId: 10143, config: "config.staging.json", chunk: 100n });
    expect(creChain("sepolia")).toMatchObject({
      chainId: 11155111,
      chainSelectorName: "ethereum-testnet-sepolia",
      config: "config.sepolia.json",
      target: "sepolia-settings",
      chunk: 1000n,
    });
    expect(CRE_CHAINS.sepolia.forwarder.mock).toBe("0x15fC6ae953E024d975e77382eEeC56A9101f9F88");
    expect(() => creChain("hyperevm-testnet")).toThrow(/not a CRE target/);
    expect(() => creChain("toString")).toThrow(/not a CRE target/);
  });

  it("uses chain-selector names the CRE SDK resolves to the same chain ids", async () => {
    for (const row of Object.values(CRE_CHAINS)) {
      const f = new URL(
        `../node_modules/@chainlink/cre-sdk/dist/generated/chain-selectors/testnet/evm/${row.chainSelectorName}.js`,
        import.meta.url,
      );
      const n = (await import(f.href)).default as { chainId: string; chainSelector: { name: string } };
      expect(n.chainSelector.name).toBe(row.chainSelectorName);
      expect(Number(n.chainId)).toBe(row.chainId);
    }
  });

  it("derives the cron from the grid's batch interval", () => {
    expect(scheduleFor(120)).toBe("5 */2 * * * *");
    expect(scheduleFor(60)).toBe("5 * * * * *");
    expect(scheduleFor(1800)).toBe("5 */30 * * * *");
    expect(scheduleFor(3600)).toBe("5 0 * * * *");
    expect(scheduleFor(21_600)).toBe("5 0 */6 * * *");
    expect(scheduleFor(86_400)).toBe("5 0 0 * * *");
    expect(() => scheduleFor(90)).toThrow(/no cron/);
    expect(() => scheduleFor(420)).toThrow(/no cron/);
  });

  it("starts a Sepolia config from the deployment and never mixes chains", () => {
    const row = creChain("sepolia");
    const sepolia = { chainId: 11155111, batchInterval: 120, keeperReceiver: "0x5149637A57030b2A07463032758F542fe987EB6A", vaults: {} };
    const base = defaultBase(row, sepolia);
    expect(base).toMatchObject({ schedule: "5 */2 * * * *", chainSelectorName: "ethereum-testnet-sepolia", isTestnet: true });
    // Sepolia's storage pricing: a first settlement of a fresh expiry does not fit Monad's 8M report gas
    expect(base.gasLimit).toBe("30000000");
    expect(defaultBase(creChain("monad-testnet"), { ...sepolia, chainId: 10143 }).gasLimit).toBe("8000000");
    expect(buildConfig(base, sepolia, [id("aa")], row)).toMatchObject({ receiver: sepolia.keeperReceiver, pools: [id("aa")] });
    // a config copied from Monad gets Sepolia's selector; a Monad deployment is refused for the Sepolia target
    const monadBase = { ...base, chainSelectorName: "monad-testnet" };
    expect(buildConfig(monadBase, sepolia, [], row).chainSelectorName).toBe("ethereum-testnet-sepolia");
    expect(() => buildConfig(base, { ...sepolia, chainId: 10143 }, [], row)).toThrow(/not ethereum-testnet-sepolia/);
  });

  it("skips a chain that has no deployments file yet without touching anything", () => {
    if (existsSync(new URL("../../../deployments/sepolia.json", import.meta.url))) return; // deployed since
    const script = new URL("../scripts/sync-config.mjs", import.meta.url).pathname;
    const out = execFileSync(process.execPath, [script], {
      env: { ...process.env, DEPLOYMENT: "sepolia" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toBe("");
    expect(existsSync(new URL("../config.sepolia.json", import.meta.url))).toBe(false);
  });
});
