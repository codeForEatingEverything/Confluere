import { deployments, chainById } from "@confluere/sdk";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Bot, type Saved } from "./bot.js";
import type { PoolClass } from "./rules.js";

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const env = process.env;
const chainId = Number(env.CHAIN_ID ?? 31337);
const chain = chainById(chainId);
const d = deployments[chainId];
if (!chain || !d) throw new Error(`no chain/deployment for ${chainId}`);
const account = privateKeyToAccount(env.PRIVATE_KEY as Hex);
const transport = http(env.RPC_URL ?? chain.rpcUrls.default.http[0]);
const pub = createPublicClient({ chain, transport }) as PublicClient;
const wallet = createWalletClient({ chain, transport, account });
const pools = (env.POOLS ?? "").split(",").filter(Boolean).map((s) => {
  const [id, cls] = s.split(":");
  return { id: id as Hex, cls: (cls ?? "main") as PoolClass };
});
// Cumulative spend per pool, the first start and the exit must survive restarts, or the published caps and the
// 8-week limit would reset on every redeploy.
const stateFile = env.STATE_FILE ?? `bootstrap-mm-state-${chainId}.json`;
const raw = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const saved: Saved = raw.spent ? raw : { spent: raw }; // older files held only the spend map
const save = () => writeFileSync(stateFile, JSON.stringify(saved, null, 2));

const bot = new Bot(
  { pub, wallet, account, d, chainId },
  {
    pools,
    perBatch: BigInt(env.PER_BATCH_QUOTE ?? "0"),
    total: BigInt(env.TOTAL_QUOTE ?? "0"),
    endAt: Number(env.END_AT ?? 0),
    leadS: Number(env.LEAD_S ?? 90),
  },
  saved,
  save,
  log,
);

const once = process.argv.includes("--once");
log("bootstrap-mm up", { chain: chainId, pools: pools.length, endAt: Number(env.END_AT ?? 0) });
do {
  try {
    await bot.tick();
  } catch (e) {
    log("tick failed", { error: String(e).slice(0, 200) });
  }
  if (!once) await new Promise((r) => setTimeout(r, 5000));
} while (!once);
