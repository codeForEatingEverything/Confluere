/**
 * Testnet operations. Reads PRIVATE_KEY from contracts/.env (never printed).
 *   pnpm --filter @confluere/ops status
 *   pnpm --filter @confluere/ops hl-to-evm HYPE 5        # HyperCore → HyperEVM
 *   pnpm --filter @confluere/ops big-blocks on|off       # around a HyperEVM deploy
 *   pnpm --filter @confluere/ops blocktime                # 24 h block count -> WINDOW_BLOCKS (read-only)
 *   pnpm --filter @confluere/ops spot-sell HYPE 1         # HyperCore testnet: sell HYPE for USDC (IOC, 5% below mid)
 *   pnpm --filter @confluere/ops cctp 10 hyperevm monad   # move testnet USDC between chains via Circle CCTP v2
 *   pnpm --filter @confluere/ops cctp-resume 0x<burnTx> hyperevm monad   # finish a CCTP transfer after its burn
 */
import { readFileSync, existsSync } from "node:fs";
import { createPublicClient, erc20Abi, formatEther, formatUnits, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hyperEvm, hyperliquidEvmTestnet, monad, monadTestnet } from "viem/chains";
import { measure } from "./blocktime.js";
import { cctp, cctpChain, relay, usdcUnits } from "./cctp.js";
import { hlPrice, post, signL1Action, signSpotSend, systemAddress } from "./hyperliquid.js";

const NET = "Testnet" as const;
const HYPEREVM_TESTNET_USDC = "0x2b3370ee501b4a559b57d449569354196457d8ab";

function loadKey(): Hex {
  const f = new URL("../../../contracts/.env", import.meta.url);
  const fromEnv = process.env.PRIVATE_KEY;
  if (fromEnv) return fromEnv as Hex;
  if (!existsSync(f)) throw new Error("put PRIVATE_KEY=0x... in contracts/.env");
  const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("PRIVATE_KEY="));
  if (!line) throw new Error("PRIVATE_KEY missing in contracts/.env");
  return line.slice("PRIVATE_KEY=".length).trim() as Hex;
}

async function status() {
  const account = privateKeyToAccount(loadKey());
  console.log(`address ${account.address}`);
  for (const chain of [monadTestnet, hyperliquidEvmTestnet]) {
    const c = createPublicClient({ chain, transport: http() });
    const bal = await c.getBalance({ address: account.address }).catch(() => undefined);
    console.log(`${chain.name.padEnd(26)} ${bal === undefined ? "rpc error" : `${formatEther(bal)} ${chain.nativeCurrency.symbol}`}`);
  }
  const he = createPublicClient({ chain: hyperliquidEvmTestnet, transport: http() });
  const usdc = await he
    .readContract({ address: HYPEREVM_TESTNET_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })
    .catch(() => undefined);
  console.log(`${"HyperEVM Testnet USDC".padEnd(26)} ${usdc === undefined ? "rpc error" : formatUnits(usdc, 6)}`);
  const core = await post(NET, "info", { type: "spotClearinghouseState", user: account.address });
  for (const b of core.balances ?? []) console.log(`${("HyperCore " + b.coin).padEnd(26)} ${b.total}`);
  const big = await post(NET, "info", { type: "userAbstraction", user: account.address }).catch(() => undefined);
  if (big) console.log(`account mode ${JSON.stringify(big)}`);
}

async function hlToEvm(name: string, amount: string) {
  const account = privateKeyToAccount(loadKey());
  const meta = await post(NET, "info", { type: "spotMeta" });
  const token = (meta.tokens as any[]).find((t) => t.name === name);
  if (!token) throw new Error(`unknown spot token ${name}`);
  const body = await signSpotSend(account, NET, {
    destination: systemAddress(token),
    token: `${token.name}:${token.tokenId}`,
    amount,
    time: Date.now(),
  });
  console.log(JSON.stringify(await post(NET, "exchange", body)));
}

async function bigBlocks(on: boolean) {
  const account = privateKeyToAccount(loadKey());
  const body = await signL1Action(account, NET, { type: "evmUserModify", usingBigBlocks: on }, Date.now());
  console.log(JSON.stringify(await post(NET, "exchange", body)));
}

async function spotSell(coin: string, size: string) {
  const account = privateKeyToAccount(loadKey());
  const meta = await post(NET, "info", { type: "spotMeta" });
  const token = (meta.tokens as any[]).find((t) => t.name === coin);
  const usdc = (meta.tokens as any[]).find((t) => t.name === "USDC");
  if (!token || !usdc) throw new Error(`unknown spot token ${coin}`);
  const pair = (meta.universe as any[]).find((u) => u.tokens[0] === token.index && u.tokens[1] === usdc.index);
  if (!pair) throw new Error(`no ${coin}/USDC spot pair`);
  const mids = await post(NET, "info", { type: "allMids" });
  const mid = Number(mids[pair.name]);
  if (!(mid > 0)) throw new Error(`no mid for ${pair.name}`);
  const action = {
    type: "order",
    orders: [{ a: 10000 + pair.index, b: false, p: hlPrice(mid * 0.95, token.szDecimals), s: size, r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
  const body = await signL1Action(account, NET, action, Date.now());
  console.log(JSON.stringify(await post(NET, "exchange", body)));
}

async function blocktime() {
  for (const chain of [monad, monadTestnet, hyperEvm, hyperliquidEvmTestnet]) {
    const m = await measure(chain).catch((e) => String(e?.shortMessage ?? e).slice(0, 80));
    if (typeof m === "string") console.log(`${chain.name.padEnd(26)} ${m}`);
    else console.log(`${chain.name.padEnd(26)} ${m.blocks} blocks in ${(m.seconds / 3600).toFixed(2)} h -> WINDOW_BLOCKS ~ ${m.window}`);
  }
}

const [cmd, a, b] = process.argv.slice(2);
const run =
  cmd === "status" ? status() : cmd === "hl-to-evm" ? hlToEvm(a ?? "HYPE", b ?? "1") : cmd === "big-blocks" ? bigBlocks(a === "on") : cmd === "blocktime" ? blocktime() : cmd === "spot-sell"
            ? spotSell(a ?? "HYPE", b ?? "1")
            : cmd === "cctp"
              ? Promise.resolve().then(() =>
                  cctp(loadKey(), usdcUnits(a ?? "1"), cctpChain(b, "hyperevm"), cctpChain(process.argv[5], "monad")),
                )
              : cmd === "cctp-resume"
                ? Promise.resolve().then(() => relay(loadKey(), (a ?? "") as Hex, cctpChain(b, "hyperevm"), cctpChain(process.argv[5], "monad")))
                : Promise.reject(new Error(`unknown command ${cmd}`));
run.catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
