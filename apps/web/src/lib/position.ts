"use client";

import { readMany } from "./many";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address, type Hex } from "viem";
import { confluereAbi, cTokenId, rTokenId } from "@confluere/sdk";
import { REFRESH_MS, useChainCtx } from "./data";
import { useViewAddress } from "./demo/hooks";

export type Position = { c: bigint; r: bigint; locked: bigint };

/** C, R and rollover-locked R balances of the connected account across pools. */
export function usePositions(ids: Hex[]) {
  const { chainId, client, deployment } = useChainCtx();
  const address = useViewAddress();
  return useQuery({
    queryKey: ["positions", chainId, address, ids],
    enabled: !!client && !!address && !!deployment && ids.length > 0,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const core = deployment!.confluere;
      const r = await readMany(client!, ids.flatMap((id) => [
          { address: core, abi: confluereAbi, functionName: "balanceOf", args: [address!, cTokenId(id)] } as const,
          { address: core, abi: confluereAbi, functionName: "balanceOf", args: [address!, rTokenId(id)] } as const,
          { address: core, abi: confluereAbi, functionName: "lockedR", args: [address!, id] } as const,
        ]));
      const out: Record<string, Position> = {};
      ids.forEach((id, i) => (out[id] = { c: r[3 * i] as bigint, r: r[3 * i + 1] as bigint, locked: r[3 * i + 2] as bigint }));
      return out;
    },
  });
}

/** Pull-model balances waiting in the core for `withdraw`. */
export function usePending(tokens: Address[]) {
  const { chainId, client, deployment } = useChainCtx();
  const address = useViewAddress();
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase() as Address))];
  return useQuery({
    queryKey: ["pending", chainId, address, uniq],
    enabled: !!client && !!address && !!deployment && uniq.length > 0,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const r = await readMany(client!, uniq.map((t) => ({ address: deployment!.confluere, abi: confluereAbi, functionName: "pending", args: [t, address!] }) as const));
      return Object.fromEntries(uniq.map((t, i) => [t, r[i] as bigint])) as Record<string, bigint>;
    },
  });
}

/** Wallet ERC-20 balances of the connected account. */
export function useBalances(tokens: Address[]) {
  const { chainId, client, deployment } = useChainCtx();
  const address = useViewAddress();
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase() as Address))].sort();
  return useQuery({
    queryKey: ["balances", chainId, address, uniq],
    enabled: !!client && !!address && uniq.length > 0,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      const r = await readMany(client!, uniq.map((t) => ({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [address!] }) as const));
      return Object.fromEntries(uniq.map((t, i) => [t, r[i] as bigint])) as Record<string, bigint>;
    },
  });
}

/** Whether `spender` is an ERC-6909 operator of the connected account on the core. */
export function useIsOperator(spender: Address | undefined) {
  const { chainId, client, deployment } = useChainCtx();
  const address = useViewAddress();
  return useQuery({
    queryKey: ["is-operator", chainId, address, spender],
    enabled: !!client && !!address && !!spender && !!deployment,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async () =>
      (await client!.readContract({ address: deployment!.confluere, abi: confluereAbi, functionName: "isOperator", args: [address!, spender!] })) as boolean,
  });
}
