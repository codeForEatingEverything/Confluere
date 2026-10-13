"use client";

/** ERC-20 allowance of the connected account for `spender` (the core by default), so a card can say "Approve X" first. */
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { REFRESH_MS, useChainCtx } from "./data";

export function useAllowance(token: Address | undefined, spender?: Address) {
  const { chainId, client, deployment } = useChainCtx();
  const { address } = useConnection();
  const who = spender ?? deployment?.confluere;
  return useQuery({
    queryKey: ["allowance", chainId, address, token?.toLowerCase(), who?.toLowerCase()],
    enabled: !!client && !!address && !!token && !!who,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async () => (await client!.readContract({ address: token!, abi: erc20Abi, functionName: "allowance", args: [address!, who!] })) as bigint,
  });
}
