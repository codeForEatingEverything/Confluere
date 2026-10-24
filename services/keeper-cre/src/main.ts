/**
 * Confluere keeper as a Chainlink CRE workflow.
 *
 * On every cron tick the DON signs a report listing the pools and vaults to keep, and the Keystone forwarder
 * delivers it to KeeperReceiver.onReport. The receiver reads each pool on-chain and performs only the transitions
 * that are due (settle, mature, close window, vault poke / roll). Nothing here touches a price: the workflow carries
 * ids, never market data. Every action is permissionless, so the self-hosted keeper and the developer buttons in the
 * app remain valid fallbacks.
 */
import { cre, getNetwork, prepareReportRequest, Runner, type Runtime } from "@chainlink/cre-sdk";
import { z } from "zod";
import { encodeTick } from "./payload";

const configSchema = z.object({
  // Six-field cron (with seconds) aligned with the deployment's batchInterval. The staging config uses
  // "5 */2 * * * *" (second 5 of every 2nd minute) for the 120 s demo grid; a 30-minute mainnet grid would use
  // "5 */30 * * * *".
  schedule: z.string(),
  // CRE chain-selector name: "monad-testnet" (config.staging.json) or "ethereum-testnet-sepolia" (config.sepolia.json);
  // scripts/sync-config.mjs CRE_CHAINS lists the targets and their forwarders.
  chainSelectorName: z.string(),
  isTestnet: z.boolean(),
  receiver: z.string(), // KeeperReceiver address from deployments/<chain>.json
  pools: z.array(z.string()),
  vaults: z.array(z.string()),
  gasLimit: z.string(),
});

type Config = z.infer<typeof configSchema>;

const onTick = (runtime: Runtime<Config>): string => {
  const c = runtime.config;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: c.chainSelectorName, isTestnet: c.isTestnet });
  if (!network) throw new Error(`unknown chain ${c.chainSelectorName}`);
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);

  const payload = encodeTick(c.pools as `0x${string}`[], c.vaults as `0x${string}`[]);
  const report = runtime.report(prepareReportRequest(payload)).result();
  const reply = evm
    .writeReport(runtime, { receiver: c.receiver, report, gasConfig: { gasLimit: c.gasLimit } })
    .result();
  runtime.log(`confluere tick: ${c.pools.length} pools, ${c.vaults.length} vaults, tx status ${String(reply.txStatus)}`);
  return "ok";
};

const initWorkflow = (config: Config) => {
  const cron = new cre.capabilities.CronCapability();
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onTick)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
