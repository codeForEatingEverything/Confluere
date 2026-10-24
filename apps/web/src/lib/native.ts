"use client";

/**
 * The network's own coin as a payable asset (IA v3.1 item 11): HYPE on HyperEVM, MON on Monad, ETH on Sepolia, listed
 * next to WHYPE / WMON / WETH. Markets trade the wrapped token; paying in the coin adds one "Wrap" step at the front of the same button flow
 * (WETH9-style `deposit()`, 1:1). There is no separate wrap or unwrap feature, no toggle, and nothing is unwrapped on
 * the way back: proceeds and refunds arrive as WHYPE / WMON and are shown as such.
 *
 * In token lists the coin uses the zero address (its logo is bundled under that address).
 */
import { useBalance } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { chainMeta, launchTokensOf } from "./chains";
import { wrapWrite } from "./tokens";
import type { Token } from "./data";
import type { Write } from "./tx";
import { useDemo } from "./demo/mode";
import { useActiveChainId } from "./activeChain";
import { useDemoNativeBalance } from "./demo/hooks";
import { useViewAddress } from "./demo/hooks";

/** The coin's address in token lists (the zero address). */
export const NATIVE: Address = zeroAddress;

export const isNative = (a: string | undefined) => !!a && a.toLowerCase() === zeroAddress;

/** The wrapped coin the deployment trades (WHYPE / WMON), if any. */
export const wrappedNativeOf = (chainId: number): Address | undefined => launchTokensOf(chainId).native;

export const isWrappedNative = (chainId: number, token: string | undefined) => !!token && wrappedNativeOf(chainId)?.toLowerCase() === token.toLowerCase();

/** The coin as a token row (zero address, 18 decimals, "HYPE" / "MON"). */
export const nativeTokenOf = (chainId: number): Token => ({ address: NATIVE, symbol: chainMeta(chainId).native, decimals: 18 });

/**
 * Kept back by Max so the wallet can still pay for the transactions (gas is paid in the same coin). Sepolia: 0.01 ETH;
 * its fork prices deployed code and big calls high (a 48-order Router batch used 20M gas on a fork, 2026-10-23), so the
 * reserve covers a few such calls at 0.1 gwei.
 */
export const GAS_RESERVE: Record<number, bigint> = { 998: 2n * 10n ** 16n, 10143: 2n * 10n ** 17n, 11155111: 10n ** 16n };
export const gasReserve = (chainId: number) => GAS_RESERVE[chainId] ?? 10n ** 16n;

/** Spendable coin: the balance minus the gas reserve (never negative). */
export const spendableNative = (balance: bigint, chainId: number) => (balance > gasReserve(chainId) ? balance - gasReserve(chainId) : 0n);

/** The wallet's coin balance on `chainId` (undefined while unknown or disconnected). */
export function useNativeBalance(chainId: number): bigint | undefined {
  const address = useViewAddress();
  const demo = useDemo();
  const b = useBalance({ address, chainId, query: { enabled: !!address && !demo, refetchInterval: 8_000 } } as never) as { data?: { value: bigint } };
  const sample = useDemoNativeBalance(address, chainId);
  return address ? (demo ? sample : b.data?.value) : undefined;
}

/** Writes with the wrap step in front: paying `amount` of the coin turns it into the wrapped token first. */
export function withWrap(chainId: number, amount: bigint, writes: Write[]): Write[] {
  const w = wrappedNativeOf(chainId);
  return w && amount > 0n ? [wrapWrite(w, amount, chainMeta(chainId).native), ...writes] : writes;
}

/** What the twin rows (lib/twins) need on the active network: the wrapped coin's address and the coin's symbol. */
export function useTwinCtx(): { wrapped: Address | undefined; coin: string } {
  const chainId = useActiveChainId();
  return { wrapped: wrappedNativeOf(chainId), coin: chainMeta(chainId).native };
}
