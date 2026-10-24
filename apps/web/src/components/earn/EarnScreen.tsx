"use client";

/**
 * Earn (IA v3.1 item 4): vaults only. Lending into one maturity yourself means getting C on the Borrow market page.
 * A vault opens its drawer (?vault=, shareable). Rates are net of the 0.015% trade fee.
 */
import Link from "next/link";
import { useMemo } from "react";
import type { Address } from "viem";
import { useConnection } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, usePools, useTokens, useVaults, type PoolRow, type VaultRow } from "@/lib/data";
import { useVaultsMe } from "@/lib/vaultMe";
import { useChainClock } from "@/lib/useProduct";
import { netReturn, rateText } from "@/lib/quote";
import { fmtToken, nativeSymbol } from "@/lib/format";
import { vaultRole, vaultSharesValue } from "@/lib/product";
import { vaultIcon, vaultLends, vaultLevel, vaultName, vaultToken } from "@/lib/vocab";
import { buyBack, takesOrders } from "@/lib/view";
import { useQueryParam } from "@/lib/url";
import { Button, ErrorRow, List, SectionTitle, TokenIcon, stop, useLiveNow, type Column } from "../ui";
import { VaultDrawer } from "./VaultDrawer";
import { payOf, twinKey, vaultTwins, type Twinned, type Via } from "@/lib/twins";
import { isWrappedNative, wrappedNativeOf } from "@/lib/native";

type Tokens = Record<string, { address: Address; symbol: string; decimals: number }> | undefined;

/** The open market a vault would lend into now: graduated, its quote, lowest (or highest) buy-back price. */
function vaultTarget(v: VaultRow, open: PoolRow[]): PoolRow | undefined {
  const fit = open.filter((p) => p.graduated && p.quote.toLowerCase() === v.quote.toLowerCase() && v.assets.some((a) => a.toLowerCase() === p.asset.toLowerCase()) && p.lastClearingPrice > 0n);
  if (!fit.length) return undefined;
  return [...fit].sort((a, b) => (vaultLevel(v) === "lower" ? Number(buyBack(a) - buyBack(b)) : Number(buyBack(b) - buyBack(a))))[0];
}

export function EarnScreen() {
  const [vaultAddr, setVault] = useQueryParam("vault");
  const pools = usePools();
  const { block } = useChainClock();
  const now = useLiveNow();
  const { meta } = useActiveChain();
  const qc = useQueryClient();
  const open = useMemo(() => (pools.data ?? []).filter((p) => now > 0 && takesOrders(p, now, block)), [pools.data, now, block]);
  const vaults = useVaults();
  const addrs = useMemo(() => [...new Set((vaults.data ?? []).flatMap((v) => [v.quote, ...v.assets]).map((a) => a.toLowerCase() as Address))], [vaults.data]);
  const tokensQ = useTokens(addrs);
  const tokens = tokensQ.data;
  const metaMissing = addrs.length > 0 && !tokens;
  const retry = () => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === meta.id });

  return (
    <div>
      <h1 className="text-amount font-semibold">Earn</h1>
      <p className="mt-2 max-w-[65ch] text-body text-ink-2" data-testid="earn-intro">
        You lend; borrowers post collateral to borrow. If they buy it back at maturity you get your money plus a fixed return; if they don&apos;t, you receive their collateral at the agreed price. A vault does this for you
        automatically, every term.
      </p>

      <section className="mt-8" id="vaults" aria-labelledby="vaults-title">
        <SectionTitle id="vaults-title">Vaults</SectionTitle>
        <VaultRows vaults={vaults.data} loading={(vaults.isLoading || metaMissing) && !vaults.data} failed={vaults.isError && !vaults.data} onRetry={retry} tokens={tokens} open={open} now={now} onOpen={(a, pay) => setVault(a, { pay })} />
        <p className="mt-3 text-caption text-ink-3">
          Rates are what the vault would earn right now, after the 0.015% trade fee. Withdrawals are paid in the loan token: vaults lend only into auto-sell markets, so defaulted collateral is sold in the next maturity's rounds first. Prefer to choose a maturity yourself?{" "}
          <Link href="/borrow" className="link">
            Lend in one market
          </Link>
          .
        </p>
      </section>

      <VaultDrawer address={vaultAddr} onClose={() => setVault(undefined, { pay: undefined })} />
    </div>
  );
}

type Row = Twinned<VaultRow>;

function VaultRows({ vaults, loading, failed, onRetry, tokens, open, now, onOpen }: { vaults?: VaultRow[]; loading: boolean; failed: boolean; onRetry: () => void; tokens: Tokens; open: PoolRow[]; now: number; onOpen: (a: string, pay?: Via) => void }) {
  const { chainId, deployment, meta } = useActiveChain();
  const { isConnected } = useConnection();
  const me = useVaultsMe(vaults).data;
  const coin = nativeSymbol(chainId);
  // a vault taking WHYPE / WMON is listed twice (lib/twins): the HYPE row deposits in HYPE, the WHYPE row in WHYPE
  const rows = useMemo(() => vaultTwins(vaults ?? [], wrappedNativeOf(chainId)), [vaults, chainId]);
  /** The coin's name on this row: HYPE on the native row, WHYPE on the wrapped one (lib/vocab names coin vaults by it). */
  const nativeOf = (v: Row) => (v.twin && v.via === "wrapped" ? (tokenOf(tokens, v.quote)?.symbol ?? `W${coin}`) : coin);
  /** The vault's money as shown: HYPE / MON on the native row of a coin vault (lib/vocab vaultToken), else the quote token. */
  const shownOf = (v: Row) => (v.twin && v.via === "wrapped" ? tokenOf(tokens, v.quote) : vaultToken(vaultRole(v, deployment?.vaults), tokenOf(tokens, v.quote), coin));
  const nameOf = (v: Row) => vaultName(vaultRole(v, deployment?.vaults), tokenOf(tokens, v.quote)?.symbol ?? "…", nativeOf(v));
  /** Borrowers' token: a USDC vault lending to WHYPE borrowers names both pairings ("HYPE / WHYPE"). */
  const borrowersOf = (v: Row) => {
    const a = tokenOf(tokens, v.assets[0]);
    return a && isWrappedNative(chainId, a.address) ? `${coin} / ${a.symbol}` : a?.symbol;
  };
  const cols: Column<Row>[] = [
    {
      key: "name",
      header: "Vault",
      cell: (v) => {
        const q = tokenOf(tokens, v.quote);
        const role = vaultRole(v, deployment?.vaults);
        const icon = v.twin && v.via === "wrapped" ? { address: q?.address, symbol: q?.symbol } : vaultIcon(role, q, coin);
        return (
          <span className="flex items-center gap-2.5" data-via={v.via}>
            <TokenIcon {...icon} size={28} />
            <span className="min-w-0">
              <span className="block font-medium text-ink" data-testid="vault-name">
                {nameOf(v)}
              </span>
              <span className="block text-caption text-ink-3">
                Lends {vaultLends(role, q?.symbol, nativeOf(v))} to {borrowersOf(v)} borrowers{role === "usd-low" ? ", lower buy-back price" : role === "usd-high" ? ", higher buy-back price" : ""}
              </span>
            </span>
          </span>
        );
      },
    },
    {
      key: "ret",
      header: "Current rate",
      end: true,
      cell: (v) => {
        const target = vaultTarget(v, open);
        if (!target) return <span className="text-ink-2">Waiting for a market</span>;
        const f = netReturn(target, now);
        return <span className="num text-body font-semibold text-ink">{rateText(f, target.expiry - now)}</span>;
      },
    },
    { key: "val", header: "Total deposits", end: true, cell: (v) => <span className="num">{fmtToken(v.totalAssets, shownOf(v), true, { compact: true })}</span> },
    {
      key: "mine",
      header: "Your position",
      end: true,
      cell: (v) => {
        if (!isConnected) return <span className="text-ink-3">Connect to see</span>;
        const m = me?.[v.address.toLowerCase()];
        return <span className="num text-ink-2">{m && m.shares > 0n ? fmtToken(vaultSharesValue(v, m.shares), shownOf(v)) : "—"}</span>;
      },
    },
    {
      key: "act",
      header: "",
      end: true,
      label: false,
      cell: (v) => (
        <Button size="sm" variant="secondary" onClick={stop(() => onOpen(v.address, payOf(v)))} className="max-lg:w-full">
          Deposit
        </Button>
      ),
    },
  ];
  if (!loading && !failed && (!vaults || vaults.length === 0)) return <p className="py-2 text-body-sm text-ink-2">No vaults on {meta.label} yet.</p>;
  return (
    <List
      testId="vaults"
      columns={cols}
      template="minmax(260px,2fr) minmax(140px,auto) minmax(130px,auto) minmax(130px,auto) auto"
      rows={rows}
      loading={loading}
      error={failed ? <ErrorRow network={meta.label} onRetry={onRetry} /> : undefined}
      rowKey={(v) => twinKey(v.address, v.via)}
      onRow={(v) => onOpen(v.address, payOf(v))}
      rowLabel={nameOf}
    />
  );
}
