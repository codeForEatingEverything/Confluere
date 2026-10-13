"use client";

/** The connected account's requests, shares and claimables in one vault (ERC-7540 async). */
import { useQuery } from "@tanstack/react-query";
import type { Address, PublicClient } from "viem";
import { confluereAbi, cTokenId, vaultAbi } from "@confluere/sdk";
import { readMany } from "./many";
import { REFRESH_MS, useChainCtx, type VaultRow } from "./data";
import { useViewAddress } from "./demo/hooks";

export type VaultMe = {
  pendingDeposit: bigint;
  claimableDeposit: bigint;
  pendingRedeem: bigint;
  claimableRedeem: bigint;
  shares: bigint;
  claimShares: bigint; // maxMint
  claimAssets: bigint; // maxWithdraw
  assetCredits: { token: Address; amount: bigint }[]; // defaulted collateral waiting for claimAssets
};

/** Vault shares carry a 6-decimal virtual offset over the quote token. */
export const SHARE_OFFSET = 6;

const REQ_FNS = ["pendingDepositRequest", "claimableDepositRequest", "pendingRedeemRequest", "claimableRedeemRequest"] as const;

const meCalls = (v: Address, account: Address, assets: Address[]) => [
  ...REQ_FNS.map((functionName) => ({ address: v, abi: vaultAbi, functionName, args: [0n, account] }) as const),
  { address: v, abi: vaultAbi, functionName: "balanceOf", args: [account] } as const,
  { address: v, abi: vaultAbi, functionName: "maxMint", args: [account] } as const,
  { address: v, abi: vaultAbi, functionName: "maxWithdraw", args: [account] } as const,
  ...assets.map((a) => ({ address: v, abi: vaultAbi, functionName: "pendingAssetCredit", args: [account, a] }) as const),
];

const toMe = (r: unknown[], assets: Address[]): VaultMe => {
  const [pd, cd, pr, cr, bal, mm, mw] = r as bigint[];
  return {
    pendingDeposit: pd!,
    claimableDeposit: cd!,
    pendingRedeem: pr!,
    claimableRedeem: cr!,
    shares: bal!,
    claimShares: mm!,
    claimAssets: mw!,
    assetCredits: assets.map((token, i) => ({ token, amount: (r[7 + i] as bigint) ?? 0n })).filter((x) => x.amount > 0n),
  };
};

/** One account's state in several vaults, in one multicall (each vault's own collateral list for credits). */
export async function readVaultsMe(client: PublicClient, account: Address, vaults: Pick<VaultRow, "address" | "assets">[]): Promise<Record<string, VaultMe>> {
  const calls = vaults.map((v) => meCalls(v.address, account, v.assets));
  const flat = await readMany(client, calls.flat());
  const out: Record<string, VaultMe> = {};
  let k = 0;
  vaults.forEach((v, i) => {
    const n = calls[i]!.length;
    out[v.address.toLowerCase()] = toMe(flat.slice(k, k + n), v.assets);
    k += n;
  });
  return out;
}

export function useVaultMe(v: Address | undefined, assets: Address[] = []) {
  const { chainId, client } = useChainCtx();
  const address = useViewAddress();
  return useQuery({
    queryKey: ["vault-me", chainId, v, address, assets],
    enabled: !!client && !!address && !!v,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<VaultMe> => toMe(await readMany(client!, meCalls(v!, address!, assets)), assets),
  });
}

/** The connected account in every listed vault (keyed by lowercase vault address). */
export function useVaultsMe(vaults: Pick<VaultRow, "address" | "assets">[] | undefined) {
  const { chainId, client } = useChainCtx();
  const address = useViewAddress();
  const list = vaults ?? [];
  return useQuery({
    queryKey: ["vaults-me", chainId, address, list.map((v) => v.address.toLowerCase())],
    enabled: !!client && !!address && list.length > 0,
    refetchInterval: REFRESH_MS,
    queryFn: () => readVaultsMe(client!, address!, list),
  });
}

/** Pool positions the vault holds (pool id, last order, and the vault's C units there). */
export function useVaultPositions(v: Address | undefined, core: Address | undefined) {
  const { chainId, client } = useChainCtx();
  return useQuery({
    queryKey: ["vault-positions", chainId, v],
    enabled: !!client && !!v && !!core,
    refetchInterval: REFRESH_MS * 2,
    queryFn: async () => {
      const ps = (await client!.readContract({ address: v!, abi: vaultAbi, functionName: "positions" })) as readonly { poolId: `0x${string}`; lastOrder: bigint }[];
      const bal = await readMany(client!, ps.map((p) => ({ address: core!, abi: confluereAbi, functionName: "balanceOf", args: [v!, cTokenId(p.poolId)] }) as const));
      return ps.map((p, i) => ({ poolId: p.poolId, lastOrder: p.lastOrder, c: bal[i] as bigint }));
    },
  });
}
