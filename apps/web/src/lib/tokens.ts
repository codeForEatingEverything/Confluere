"use client";

/**
 * Getting a token the selected market needs, as the smallest possible step (spec requirement (a)): a link to Circle's
 * faucet for testnet USDC; for WHYPE / WMON / WETH the step is "wrap", which the UI shows as "Pay with HYPE / MON instead"
 * (IA v3.1 item 11: the native coin is a pay-with choice and the wrap runs inside the card's own button flow, never as
 * a separate wrap button). Never staking: an LST (shMON, wstETH) is only mentioned inside the Loop flow on a staked-token
 * market, through `stakeStep`. Mock tokens (anvil) have a public `mint`, proven by a dry run before it is offered.
 */
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { erc20Abi, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { mockErc20Abi } from "@confluere/sdk";
import { launchTokensOf } from "./chains";
import { CHAIN_ID } from "./config";
import { readMany } from "./many";
import { nativeSymbol } from "./format";
import { useChainCtx } from "./data";
import type { Write } from "./tx";

export const wrapAbi = parseAbi(["function deposit() payable"]);
export const unwrapAbi = parseAbi(["function withdraw(uint256 wad)"]);
export const stakeAbi = parseAbi(["function deposit(uint256 assets, address receiver) payable returns (uint256)"]);

export type Obtain =
  | { kind: "wrap"; note: string }
  | { kind: "stake"; note: string; href?: string; /** Who stakes it ("FastLane", "Lido"); the Loop flow names them. */ provider: string }
  | { kind: "link"; note: string; href: string };

export const CIRCLE_FAUCET = "https://faucet.circle.com";

/** Known real tokens per chain (lowercase address). */
const KNOWN: Record<number, Record<string, Obtain>> = {
  10143: {
    "0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541": { kind: "wrap", note: "WMON is MON, wrapped 1:1." },
    "0x534b2f3a21130d7a60830c2df862319e593943a3": { kind: "link", note: "Testnet USDC comes from Circle's faucet.", href: CIRCLE_FAUCET },
    "0x282bddff5e58793acab65438b257dbd15a8745c9": { kind: "stake", note: "shMON is staked MON (FastLane).", href: "https://shmonad.xyz", provider: "FastLane" },
  },
  // Sepolia: Uniswap's canonical WETH9, Circle's USDC, Lido's wstETH (staked ETH, wrapped). Lido has no Sepolia staking
  // site, so no link: the note says what to do (ETH sent to the wstETH contract is staked and wrapped in one step).
  11155111: {
    "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": { kind: "wrap", note: "WETH is ETH, wrapped 1:1." },
    "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": { kind: "link", note: "Testnet USDC comes from Circle's faucet.", href: CIRCLE_FAUCET },
    "0xb82381a3fbd3fafa77b3a7be693342618240067b": { kind: "stake", note: "Send Sepolia ETH to the wstETH contract 0xB82381A3fBD3FaFA77B3a7bE693342618240067b; it stakes and wraps it.", provider: "Lido" },
  },
  998: {
    "0x5555555555555555555555555555555555555555": { kind: "wrap", note: "WHYPE is HYPE, wrapped 1:1." },
    "0x2b3370ee501b4a559b57d449569354196457d8ab": { kind: "link", note: "Testnet USDC comes from Circle's faucet.", href: CIRCLE_FAUCET },
  },
};

export const NATIVE_FAUCET: Record<number, string> = {
  10143: "https://faucet.monad.xyz",
  998: "https://app.hyperliquid-testnet.xyz/drip",
  11155111: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
};

/**
 * How to get `address` on `chainId`, or undefined. Staking is returned only with `allowStake` (the Loop flow on an
 * LST market); everywhere else an LST yields nothing.
 */
export function obtainInfo(address: string, symbol: string, chainId: number, o: { allowStake?: boolean } = {}): Obtain | undefined {
  const k = KNOWN[chainId]?.[address.toLowerCase()];
  if (k) return k.kind === "stake" && !o.allowStake ? undefined : k;
  if (symbol.toUpperCase().includes("USDC")) return { kind: "link", note: "Testnet USDC comes from Circle's faucet.", href: CIRCLE_FAUCET };
  if (symbol.toUpperCase() === `W${nativeSymbol(chainId)}`) return { kind: "wrap", note: `${symbol} is ${nativeSymbol(chainId)}, wrapped 1:1.` };
  return undefined;
}

/** The single step to get a token the user lacks (UI shows it inside the card that needs it, never globally). */
export type GetTokenStep =
  | { kind: "wrap"; token: Address; native: string; label: string }
  | { kind: "faucet"; href: string; label: string }
  | { kind: "mint"; token: Address; label: string };

export function getTokenStep(chainId: number, t: { address: Address; symbol: string }, mintable = false): GetTokenStep | undefined {
  if (mintable) return { kind: "mint", token: t.address, label: `Get test ${t.symbol}` };
  const o = obtainInfo(t.address, t.symbol, chainId);
  if (o?.kind === "wrap") return { kind: "wrap", token: t.address, native: nativeSymbol(chainId), label: `Wrap ${nativeSymbol(chainId)}` };
  if (o?.kind === "link") return { kind: "faucet", href: o.href, label: `Get ${t.symbol}` };
  return undefined;
}

/** Loop flow only: one line on how the LST is made (staking happens outside Confluere). */
export function stakeStep(chainId: number, lst: Address): { note: string; href?: string; provider: string } | undefined {
  const k = KNOWN[chainId]?.[lst.toLowerCase()];
  return k?.kind === "stake" ? { note: k.note, href: k.href, provider: k.provider } : undefined;
}

/** Transaction for the wrap step (WETH9-style deposit(), 1:1). */
export const wrapWrite = (token: Address, amount: bigint, native: string): Write => ({
  label: `Wrap ${native}`,
  address: token,
  abi: wrapAbi,
  functionName: "deposit",
  value: amount,
});

/**
 * Transaction for the unwrap step (WETH9-style withdraw(wad), 1:1): only when the person chose to receive the coin
 * (HYPE / MON) rather than the wrapped token, right after the wrapped token reached their wallet.
 */
export const unwrapWrite = (token: Address, amount: bigint, native: string): Write => ({
  label: `Unwrap to ${native}`,
  address: token,
  abi: unwrapAbi,
  functionName: "withdraw",
  args: [amount],
});

/** Transaction for a mock token mint (anvil demos). */
export const mintWrite = (token: Address, to: Address, amount: bigint, symbol: string): Write => ({
  label: `Get test ${symbol}`,
  address: token,
  abi: mockErc20Abi,
  functionName: "mint",
  args: [to, amount],
});

/** The launch tokens of a chain's deployment (mock `tokens`, or the real ones under `pools`), zero addresses skipped. */
export function launchTokens(chainId: number = CHAIN_ID): Address[] {
  const t = launchTokensOf(chainId);
  return [t.lst, t.native, t.usdc].filter((a): a is Address => !!a);
}

const PROBE = "0x0000000000000000000000000000000000000001" as const;
/** A selector no token implements: if a call with it succeeds, the contract has a catch-all fallback. */
const UNKNOWN_SELECTOR: Hex = "0x8a5c3f1e";

/**
 * Whether `token` has a public mint, proven by a dry run. Known real tokens are never probed, and a contract whose
 * fallback accepts any call (WETH9-style WHYPE / WMON run deposit() with 0 value) is not mintable even though its
 * `mint` dry run "succeeds" with empty return data.
 */
export async function probeMintable(
  client: Pick<PublicClient, "call" | "simulateContract">,
  token: Address,
  account: Address,
  chainId: number,
): Promise<boolean> {
  if (KNOWN[chainId]?.[token.toLowerCase()]) return false;
  try {
    await client.call({ to: token, data: UNKNOWN_SELECTOR, account });
    return false;
  } catch {}
  try {
    await client.simulateContract({ address: token, abi: mockErc20Abi, functionName: "mint", args: [account, 1n], account });
    return true;
  } catch {
    return false;
  }
}

export type TokenNeed = {
  balance: bigint;
  /** Native coin balance (what a wrap step can use). */
  nativeBalance: bigint;
  /** How much is missing for `need` (0 when the wallet has enough). */
  missing: bigint;
  /** The one step to show inside the card, only when something is missing. */
  step?: GetTokenStep;
};

/**
 * What the connected wallet lacks of `token` for an action needing `need`, and the minimal step to get it.
 * Disabled until a token and a positive need are known; never suggests anything when the balance suffices.
 */
export function useTokenNeed(token: { address: Address; symbol: string } | undefined, need: bigint | undefined) {
  const { chainId, client } = useChainCtx();
  const { address } = useConnection();
  return useQuery({
    queryKey: ["token-need", chainId, address, token?.address.toLowerCase(), need?.toString()],
    enabled: !!client && !!address && !!token && need !== undefined && need > 0n,
    staleTime: 4_000,
    queryFn: async (): Promise<TokenNeed> => {
      const [bal, nat] = await Promise.all([
        client!.readContract({ address: token!.address, abi: erc20Abi, functionName: "balanceOf", args: [address!] }) as Promise<bigint>,
        client!.getBalance({ address: address! }),
      ]);
      const missing = need! > bal ? need! - bal : 0n;
      if (missing === 0n) return { balance: bal, nativeBalance: nat, missing };
      const mintable = await probeMintable(client!, token!.address, address!, chainId);
      return { balance: bal, nativeBalance: nat, missing, step: getTokenStep(chainId, token!, mintable) };
    },
  });
}

export type FaucetToken = { address: Address; symbol: string; decimals: number; mintable: boolean; obtain?: Obtain };

/** Launch tokens of the active chain with how to get each (Developers / More only; never a global banner). */
export function useFaucetTokens() {
  const { chainId, client } = useChainCtx();
  const { address } = useConnection();
  const list = launchTokens(chainId);
  return useQuery({
    queryKey: ["faucet-tokens", chainId, list, address],
    enabled: !!client && list.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<FaucetToken[]> => {
      const meta = await readMany(
        client!,
        list.flatMap((a) => [
          { address: a, abi: erc20Abi, functionName: "symbol" } as const,
          { address: a, abi: erc20Abi, functionName: "decimals" } as const,
        ]),
      );
      return Promise.all(
        list.map(async (a, i) => {
          const symbol = meta[2 * i] as string;
          const decimals = Number(meta[2 * i + 1]);
          const mintable = await probeMintable(client!, a, address ?? PROBE, chainId);
          return { address: a, symbol, decimals, mintable, obtain: mintable ? undefined : obtainInfo(a, symbol, chainId) };
        }),
      );
    },
  });
}
