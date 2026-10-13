import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, type Account } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.js";

export type Clients = { pub: PublicClient; wallet: WalletClient; account: Account };

export function makeClients(cfg: Config): Clients {
  const account = privateKeyToAccount(cfg.privateKey);
  // public testnet RPCs rate-limit bursts (HyperEVM) and drop connections: back off and retry
  const transport = http(cfg.rpcUrl, { retryCount: 6, retryDelay: 1500 });
  return {
    pub: createPublicClient({ chain: cfg.chain, transport, pollingInterval: cfg.pollMs }) as PublicClient,
    wallet: createWalletClient({ chain: cfg.chain, transport, account }),
    account,
  };
}
