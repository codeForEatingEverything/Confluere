/**
 * Testnet USDC between HyperEVM and Monad through Circle CCTP v2 (burn, Circle attestation, mint). No web faucet,
 * no captcha: the attestation comes from Circle's public sandbox API. Verified 2026-10-12: 10 USDC HyperEVM → Monad.
 */
import { createPublicClient, createWalletClient, http, pad, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hyperliquidEvmTestnet, monadTestnet } from "viem/chains";

export const CCTP = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  iris: "https://iris-api-sandbox.circle.com/v2/messages",
} as const;

export const CCTP_CHAINS = {
  hyperevm: { chain: hyperliquidEvmTestnet, domain: 19, usdc: "0x2B3370eE501B4a559b57D449569354196457D8Ab" },
  monad: { chain: monadTestnet, domain: 15, usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3" },
} as const;

const abi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)",
  "function receiveMessage(bytes message,bytes attestation) returns (bool)",
]);

export type CctpChain = keyof typeof CCTP_CHAINS;

/** Checks a chain name from the command line before anything is sent. */
export function cctpChain(name: string | undefined, fallback: CctpChain): CctpChain {
  const n = name ?? fallback;
  if (!Object.hasOwn(CCTP_CHAINS, n)) throw new Error(`unknown chain ${n}; use one of ${Object.keys(CCTP_CHAINS).join(", ")}`);
  return n as CctpChain;
}

/** "10.5" USDC -> 10500000 base units; rejects anything that is not a positive number. */
export function usdcUnits(s: string): bigint {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`amount must be a positive number, got ${s}`);
  return BigInt(Math.round(n * 1e6));
}

export const resumeCommand = (burn: Hex, from: CctpChain, to: CctpChain) => `pnpm --filter @confluere/ops cctp-resume ${burn} ${from} ${to}`;

type Message = { status: string; message: Hex; attestation: Hex };

export type PollOpts = {
  timeoutMs?: number;
  pollMs?: number;
  fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Polls Circle's Iris API for the burn's attestation. Gives up after `timeoutMs` (default 30 min) so the command does
 * not hang forever; the burn stays relayable by anyone (destinationCaller = 0) with `cctp-resume`.
 */
export async function awaitAttestation(srcDomain: number, burn: Hex, o: PollOpts = {}): Promise<Message> {
  const timeoutMs = o.timeoutMs ?? 30 * 60_000;
  const pollMs = o.pollMs ?? 20_000;
  const get = o.fetch ?? ((url: string) => fetch(url));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const r = await get(`${CCTP.iris}/${srcDomain}?transactionHash=${burn}`).catch(() => null);
    const m = r?.ok ? ((await r.json().catch(() => ({}))) as { messages?: Message[] }).messages?.[0] : undefined;
    if (m?.status === "complete") return m;
    if (now() + pollMs > deadline) throw new Error(`no attestation for ${burn} after ${Math.round(timeoutMs / 60_000)} min`);
    await sleep(pollMs);
  }
}

function clients(key: Hex, from: CctpChain, to: CctpChain) {
  const account = privateKeyToAccount(key);
  const src = CCTP_CHAINS[from];
  const dst = CCTP_CHAINS[to];
  return {
    account,
    src,
    dst,
    sPub: createPublicClient({ chain: src.chain, transport: http(undefined, { retryCount: 5 }) }),
    sWal: createWalletClient({ chain: src.chain, transport: http(undefined, { retryCount: 5 }), account }),
    dPub: createPublicClient({ chain: dst.chain, transport: http(undefined, { retryCount: 5 }) }),
    dWal: createWalletClient({ chain: dst.chain, transport: http(undefined, { retryCount: 5 }), account }),
  };
}

export async function cctp(key: Hex, amount: bigint, from: CctpChain, to: CctpChain) {
  if (from === to) throw new Error("from and to must be different chains");
  if (amount <= 0n) throw new Error("amount must be positive");
  const { account, src, dst, sPub, sWal } = clients(key, from, to);

  await sPub.waitForTransactionReceipt({ hash: await sWal.writeContract({ address: src.usdc, abi, functionName: "approve", args: [CCTP.tokenMessenger, amount] }) });
  const burn = await sWal.writeContract({
    address: CCTP.tokenMessenger,
    abi,
    functionName: "depositForBurn",
    // standard transfer: no fee, finality threshold 2000; anyone may relay (destinationCaller = 0)
    args: [amount, dst.domain, pad(account.address), src.usdc, pad("0x00"), 0n, 2000],
  });
  // print the hash before waiting on anything: from here on an interruption leaves burned USDC to relay by hand
  console.log(`burn sent on ${from}: ${burn}\nif this stops before the mint, finish it with: ${resumeCommand(burn, from, to)}`);
  try {
    await sPub.waitForTransactionReceipt({ hash: burn });
    console.log(`burn confirmed; waiting for Circle's attestation (standard finality, minutes)`);
  } catch (e) {
    throw withResume(e, burn, from, to);
  }
  await relay(key, burn, from, to);
}

/** Finishes a transfer whose burn already happened: waits for the attestation and calls receiveMessage. */
export async function relay(key: Hex, burn: Hex, from: CctpChain, to: CctpChain, o: PollOpts = {}) {
  if (from === to) throw new Error("from and to must be different chains");
  if (!/^0x[0-9a-fA-F]{64}$/.test(burn)) throw new Error(`not a transaction hash: ${burn}`);
  const { src, dPub, dWal } = clients(key, from, to);
  try {
    const m = await awaitAttestation(src.domain, burn, o);
    const mint = await dWal.writeContract({ address: CCTP.messageTransmitter, abi, functionName: "receiveMessage", args: [m.message, m.attestation] });
    await dPub.waitForTransactionReceipt({ hash: mint });
    console.log(`minted on ${to}: ${mint}`);
  } catch (e) {
    throw withResume(e, burn, from, to);
  }
}

function withResume(e: unknown, burn: Hex, from: CctpChain, to: CctpChain): Error {
  const msg = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  return new Error(`${msg}\nburn ${burn} is not lost; resume with: ${resumeCommand(burn, from, to)}`);
}
