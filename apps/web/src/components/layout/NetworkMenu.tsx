"use client";

import { useQueries } from "@tanstack/react-query";
import { Check, ChevronDown, LoaderCircle, TriangleAlert } from "lucide-react";
import { useActiveChain, useSwitchNetwork } from "@/lib/activeChain";
import { ENABLED, deploymentOf, type ChainMeta } from "@/lib/chains";
import { chainLogo } from "@/lib/logos";
import { useNow, type PoolIndex } from "@/lib/data";
import { appFetch } from "@/lib/demo/client";
import { useNetworkStatus } from "@/lib/network";
import { networkName } from "@/lib/vocab";
import { Menu } from "../ui/Overlay";

/** The chain's official mark (bundled under public/chains), a neutral disc for anything else. */
export function ChainLogo({ id, size = 20 }: { id: number; size?: number }) {
  const src = chainLogo(id);
  if (!src) return <span aria-hidden className="inline-block flex-none rounded-full bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]" style={{ width: size, height: size }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" aria-hidden width={size} height={size} className="flex-none rounded-full" style={{ width: size, height: size }} />;
}

const KNOWN: Record<number, string> = { 1: "Ethereum", 10: "OP Mainnet", 56: "BNB Chain", 137: "Polygon", 143: "Monad", 999: "HyperEVM", 8453: "Base", 42161: "Arbitrum One", 11155111: "Sepolia" };
/** Name of a common EVM chain id, for "Your wallet is on Ethereum" (no full chain list in the bundle). */
const anyChainName = (id: number | undefined) => (id !== undefined && KNOWN[id]) || "another network";

/** Markets with a maturity still ahead, per chain, from the server index (no chain reads, so the menu opens instantly). */
export function openMarketCount(idx: PoolIndex | undefined, nowS: number): number | undefined {
  if (!idx) return undefined;
  const n = new Set(idx.pools.filter((p) => (p.expiry ?? 0) > nowS).map((p) => p.marketId ?? `${p.asset}/${p.quote}/${p.kind}`)).size;
  // while the server's first scan is still running the pools' details are unknown: say "Checking", never "No open markets"
  return n === 0 && !idx.status?.complete ? undefined : n;
}

function useMarketCounts(chains: ChainMeta[]) {
  const qs = useQueries({
    queries: chains.map((c) => ({
      queryKey: ["pool-index", c.id],
      enabled: !!deploymentOf(c.id),
      staleTime: 15_000,
      queryFn: async (): Promise<PoolIndex> => {
        const r = await appFetch(`/api/pools?chain=${c.id}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as PoolIndex;
      },
    })),
  });
  const now = Date.now() / 1000;
  return chains.map((c, i) => ({ chain: c, open: openMarketCount(qs[i]?.data, now) }));
}

/** Chain health in one line, for the bottom of the menu. */
function HealthLine() {
  const s = useNetworkStatus();
  const head = useNow().data;
  const stale = head ? Math.round(Date.now() / 1000 - head.ts) : 0;
  const bad = s.state === "retrying" || s.state === "down" || (!!head && stale > 12);
  const text = s.state === "retrying" || s.state === "down" ? "Network busy, retrying…" : !head ? "Connecting…" : stale > 12 ? `No new block for ${stale} s` : "Connected";
  return (
    <p className="flex items-center gap-2 px-2.5 pb-1 pt-2 text-caption text-ink-3">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${bad ? "bg-warn" : head ? "bg-good" : "bg-ink-3"}`} />
      {text}
    </p>
  );
}

/**
 * Network switch: works without a wallet; with one, asks the wallet to follow. The pill itself carries the wallet's
 * wrong-network state ("Wrong network", warn colour) and a spinner while the wallet is asked.
 */
export function NetworkMenu({ compact }: { compact?: boolean }) {
  const { chainId, meta, walletOnOtherChain, walletChainId } = useActiveChain();
  const { switchNetwork, switching } = useSwitchNetwork();
  const rows = useMarketCounts(ENABLED.filter((c) => !!deploymentOf(c.id)));
  return (
    <Menu
      label="Network"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={switching}
          aria-expanded={open}
          aria-controls={id}
          aria-haspopup="menu"
          aria-label={compact ? (walletOnOtherChain ? "Wrong network" : `Network: ${networkName(meta)}`) : undefined}
          className={`btn btn-md gap-2 ${walletOnOtherChain ? "bg-warn-soft text-warn" : "btn-secondary"} ${compact ? "px-2" : "px-3"}`}
          data-testid="network-menu"
        >
          {switching ? <LoaderCircle size={20} strokeWidth={1.75} className="spin" aria-hidden /> : walletOnOtherChain ? <TriangleAlert size={18} strokeWidth={1.75} aria-hidden /> : <ChainLogo id={chainId} />}
          {!compact && (
            <span className="text-body-sm font-medium">
              {walletOnOtherChain ? "Wrong network" : meta.name}
              {!walletOnOtherChain && meta.testnet && <span className="ml-1.5 font-normal text-ink-3">Testnet</span>}
            </span>
          )}
          <ChevronDown size={16} strokeWidth={1.75} className={walletOnOtherChain ? "" : "text-ink-3"} aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div className="w-[272px]">
          {rows.map(({ chain: c, open }) => {
            const on = c.id === chainId;
            return (
              <button
                key={c.id}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className="menu-item"
                data-testid={`network-${c.id}`}
                onClick={() => {
                  close();
                  if (!on || walletOnOtherChain) void switchNetwork(c.id);
                }}
              >
                <ChainLogo id={c.id} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {c.name}
                    {c.testnet && <span className="ml-1.5 text-caption font-normal text-ink-3">Testnet</span>}
                  </span>
                  <span className="block text-caption text-ink-3">{open === undefined ? "Checking markets…" : open > 0 ? `${open} market${open > 1 ? "s" : ""} open` : "No open markets"}</span>
                </span>
                {on && <Check size={16} strokeWidth={1.75} className="text-brand" aria-hidden />}
              </button>
            );
          })}
          {walletOnOtherChain && <p className="px-2.5 pt-2 text-caption text-warn">Your wallet is on {anyChainName(walletChainId)}. Pick a network to switch it.</p>}
          <div className="mx-1 mt-1 h-px bg-line" role="separator" />
          <HealthLine />
        </div>
      )}
    </Menu>
  );
}
