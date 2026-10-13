import { loadConfig } from "./config.js";
import { makeClients } from "./chain.js";
import { Discovery } from "./discover.js";
import { Tasks, type Log } from "./tasks.js";
import { startHintServer } from "./hints.js";
import { tick } from "./tick.js";

const log: Log = (msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

async function main() {
  const cfg = loadConfig();
  const c = makeClients(cfg);
  const d = cfg.deployment;
  const disc = new Discovery(c, d.confluere, d.vaultFactory, BigInt(d.deployBlock), cfg.logChunk);
  const tasks = new Tasks(c, d, cfg, log);
  const once = process.argv.includes("--once");
  if (!once && cfg.hintPort > 0) startHintServer(c, d.confluere, cfg.hintPort);
  log("keeper up", { chain: cfg.chain.id, core: d.confluere, keeper: c.account.address });

  do {
    try {
      await tick(c, disc, tasks, log);
    } catch (e) {
      log("tick failed", { error: String(e).slice(0, 200) });
    }
    if (!once) await new Promise((r) => setTimeout(r, cfg.pollMs));
  } while (!once);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
