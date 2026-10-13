"use client";

/** Vaults in the Markets pro view: rule, size, queued deposits and withdrawals, the current period. A row opens the vault drawer. */
import type { Address } from "viem";
import { useMemo } from "react";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, useTokens, useVaults, type VaultRow } from "@/lib/data";
import { vaultRole } from "@/lib/product";
import { vaultIcon, vaultLevel, vaultName, vaultToken } from "@/lib/vocab";
import { fmtChip, fmtToken, nativeSymbol } from "@/lib/format";
import { List, TokenIcon, type Column, useLiveNow } from "../ui";

export function VaultTable({ onOpen }: { onOpen: (address: string) => void }) {
  const { chainId, deployment, meta } = useActiveChain();
  const vaults = useVaults();
  const now = useLiveNow();
  const addrs = useMemo(() => [...new Set((vaults.data ?? []).flatMap((v) => [v.quote, ...v.assets]).map((a) => a.toLowerCase() as Address))], [vaults.data]);
  const tokens = useTokens(addrs).data;
  const native = nativeSymbol(chainId);
  const cols: Column<VaultRow>[] = [
    {
      key: "v",
      header: "Vault",
      cell: (v) => {
        const q = tokenOf(tokens, v.quote);
        const role = vaultRole(v, deployment?.vaults);
        return (
          <span className="flex items-center gap-2.5">
            <TokenIcon {...vaultIcon(role, q, native)} size={28} />
            <span className="min-w-0">
              <span className="block font-medium text-ink">{vaultName(role, q?.symbol ?? "…", native)}</span>
              <span className="mono block text-caption text-ink-3">{v.symbol}</span>
            </span>
          </span>
        );
      },
    },
    { key: "rule", header: "Rule", cell: (v) => <span className="text-ink-2">{vaultLevel(v) === "lower" ? "Lower" : "Higher"} buy-back price, {v.capBps / 100}% per round</span> },
    { key: "tvl", header: "Total deposits", end: true, cell: (v) => <span className="num">{fmtToken(v.totalAssets, vaultToken(vaultRole(v, deployment?.vaults), tokenOf(tokens, v.quote), native), true, { compact: true })}</span> },
    { key: "q", header: "Queued deposits", end: true, wide: true, cell: (v) => <span className="num text-ink-2">{fmtToken(v.pendingDeposits, vaultToken(vaultRole(v, deployment?.vaults), tokenOf(tokens, v.quote), native), true, { compact: true })}</span> },
    { key: "p", header: "Period", end: true, cell: (v) => <span className="num text-ink-2">{String(v.epoch)}, {v.targetExpiry > now ? `ends ${fmtChip(v.targetExpiry)}` : "ended"}</span> },
  ];
  if (!vaults.isLoading && (vaults.data ?? []).length === 0) return <p className="text-body-sm text-ink-2">No vaults on {meta.label} yet.</p>;
  return (
    <List
      testId="pro-vaults"
      columns={cols}
      template="minmax(240px,1.6fr) minmax(220px,1.4fr) minmax(120px,auto) minmax(130px,auto) minmax(160px,auto)"
      rows={vaults.data ?? []}
      loading={vaults.isLoading && !vaults.data}
      rowKey={(v) => v.address}
      onRow={(v) => onOpen(v.address)}
      rowLabel={(v) => v.symbol}
    />
  );
}
