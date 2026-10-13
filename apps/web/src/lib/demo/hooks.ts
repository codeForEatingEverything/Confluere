"use client";

/** React side of the demo seam: the client data hooks read with, and wallet values the sample network holds. */
import { useSyncExternalStore } from "react";
import { useConnection } from "wagmi";
import type { Address, PublicClient } from "viem";
import { useDemo } from "./mode";
import { demoClient } from "./client";
import { DEMO_ACCOUNT, nativeBalance, onDemoChange } from "./chain";

/** The sample network's client in demo mode, else `live` unchanged. */
export function useDemoClientOr<T extends PublicClient | undefined>(live: T, chainId: number): T {
  const demo = useDemo();
  return (demo ? demoClient(chainId) : live) as T;
}

const subscribe = (f: () => void) => onDemoChange(() => f());

/** The wallet's coin balance on the sample network (undefined outside demo mode or without an address). */
export function useDemoNativeBalance(address: Address | undefined, chainId: number): bigint | undefined {
  const demo = useDemo();
  return useSyncExternalStore(
    subscribe,
    () => (demo && address ? nativeBalance(chainId, address) : undefined),
    () => undefined,
  );
}

/**
 * The account the read hooks show: the connected wallet, or in demo mode with no wallet the sample account, so the demo
 * Portfolio, Earn and LP screens show positions before anyone connects. Actions still need a connected wallet.
 */
export function useViewAddress(): Address | undefined {
  const { address } = useConnection();
  const demo = useDemo();
  return address ?? (demo ? DEMO_ACCOUNT : undefined);
}
