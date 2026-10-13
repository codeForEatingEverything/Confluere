"use client";

/**
 * Markets, the pro view (IA v3.1 item 5): every pool on the network, loop markets included, grouped by pair and
 * repayment style, one row per maturity and buy-back price, with round information (last traded, rounds, price guard)
 * and the market drawer (past rounds, open offers, rules). Vaults follow as their own list. "Create market" sits at the
 * right end of the filter row.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Status, marketId } from "@confluere/sdk";
import { useBestOffers } from "@/lib/secondary";
import type { Address } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, useBlockTime, usePoolSupplies, usePools, useTokens, type PoolRow, type Token } from "@/lib/data";
import { useChainClock } from "@/lib/useProduct";
import { useSeat, isVacant } from "@/lib/seats";
import { netReturn, rateText } from "@/lib/quote";
import { fmtChip, fmtPer, fmtToken, fmtWait, short } from "@/lib/format";
import { buyBack, lastTraded, nextRoundAt, poolState, roundsDone } from "@/lib/view";
import { networkName } from "@/lib/vocab";
import { useQueryParam } from "@/lib/url";
import { Chip, ErrorRow, List, Pill, TokenIcon, type Column, useLiveNow } from "../ui";
import { PoolDrawer, stateWord } from "./PoolDrawer";
import { VaultTable } from "./VaultTable";
import { VaultDrawer } from "../earn/VaultDrawer";
import { latestMaturities, isPegged } from "@/lib/markets";
import { loopMarkets } from "@/lib/loop";
import { Plus } from "lucide-react";
import { pairKey, pairName, payOf, shownToken, poolTwins, twinKey, type Twinned } from "@/lib/twins";
import { useTwinCtx } from "@/lib/native";
import { pairChips } from "../borrow/BorrowMarkets";

type Tokens = Record<string, Token> | undefined;

export function MarketsScreen() {
  const params = useSearchParams();
  const { meta } = useActiveChain();
  const qc = useQueryClient();
  const tw = useTwinCtx();
  const [poolId, setPool] = useQueryParam("pool");
  const [market, setMarket] = useQueryParam("market");
  const [vaultAddr, setVault] = useQueryParam("vault");
  const [pair, setPair] = useState("all");
  const [closed, setClosed] = useState(params?.get("closed") === "1");
  const pools = usePools();
  const { block } = useChainClock();
  const now = useLiveNow();
  const spb = useBlockTime().data;
  const all = useMemo(() => pools.data ?? [], [pools.data]);
  const loopIds = useMemo(() => new Set(loopMarkets(all, meta.id).map((p) => p.id)), [all, meta.id]);
  const tokensQ = useTokens(useMemo(() => [...new Set(all.flatMap((p) => [p.asset, p.quote]))] as Address[], [all]));
  const tokens = tokensQ.data;
  const supplies = usePoolSupplies(all.map((p) => p.id)).data;
  const offers = useBestOffers(useMemo(() => all.filter((p) => p.status !== Status.Closed).map((p) => p.id as `0x${string}`), [all])).data;
  const pairs = pairChips(all, tw.wrapped);
  const isLive = (p: PoolRow) => poolState(p, now, block) !== "closed";
  // default view: pools not closed, three maturities per pair at most; closed ones only behind the history button
  const showClosed = closed;
  const sorted = (showClosed ? all : latestMaturities(all.filter(isLive), isLive))
    .filter((p) => !market || marketId(p.asset, p.quote, p.kind).toLowerCase() === market.toLowerCase())
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (isLive(a) ? a.expiry - b.expiry : b.expiry - a.expiry) || (buyBack(a) < buyBack(b) ? -1 : 1));
  // one group per market and pairing (lib/twins): HYPE / USDC right before WHYPE / USDC, the same pools
  const rows = poolTwins(sorted, tw.wrapped).filter((p) => pair === "all" || pairKey(p) === pair);
  const gkey = (p: Twinned<PoolRow>) => twinKey(marketId(p.asset, p.quote, p.kind), p.via);
  const groups = [...rows.reduce((m, p) => m.set(gkey(p), [...(m.get(gkey(p)) ?? []), p]), new Map<string, Twinned<PoolRow>[]>()).entries()].sort(([, a], [, b]) => {
    // keep each market's two pairings together, native first, in the order the markets first appear
    const ia = rows.findIndex((r) => marketId(r.asset, r.quote, r.kind) === marketId(a[0]!.asset, a[0]!.quote, a[0]!.kind));
    const ib = rows.findIndex((r) => marketId(r.asset, r.quote, r.kind) === marketId(b[0]!.asset, b[0]!.quote, b[0]!.kind));
    return ia - ib || (a[0]!.via === "native" ? -1 : 1) - (b[0]!.via === "native" ? -1 : 1);
  });
  const name = (p: Twinned<PoolRow>) => pairName(tokens, p, tw.wrapped, tw.coin);
  const shown = (p: Twinned<PoolRow>, a: string) => shownToken(tokenOf(tokens, a), a, p.via, tw.wrapped, tw.coin);
  const loading = pools.isLoading || now === 0 || (all.length > 0 && !tokens);
  const failed = pools.isError && !pools.data;

  const cols: Column<Twinned<PoolRow>>[] = [
    {
      key: "e",
      header: "Maturity (UTC)",
      cell: (p) => (
        <span className="num">
          <span className="block font-medium text-ink">{fmtChip(p.expiry)}</span>
          <span className="block text-caption text-ink-3">{p.expiry > now ? `in ${fmtWait(p.expiry - now)}` : "matured"}</span>
        </span>
      ),
    },
    { key: "k", header: "Buy-back", end: true, cell: (p) => <span className="num">{fmtPer(buyBack(p), tokenOf(tokens, p.quote))}</span> },
    {
      key: "ft",
      header: "C price / APR",
      end: true,
      cell: (p) => {
        const f = netReturn(p, now);
        return (
          <span className="num" title={`Last traded ${lastTraded(p) > 0n ? fmtPer(lastTraded(p), tokenOf(tokens, p.quote)) : "not yet"}`}>
            <span className="block text-ink">{lastTraded(p) > 0n ? fmtPer(lastTraded(p), tokenOf(tokens, p.quote)) : "—"}</span>
            <span className="block text-caption font-semibold text-ink-2">{f.priced ? rateText(f, Math.max(0, p.expiry - now)) : "—"}</span>
          </span>
        );
      },
    },
    {
      key: "br",
      header: "R price",
      end: true,
      cell: (p) => {
        const ask = offers?.[p.id.toLowerCase()]?.brAsk;
        return <span className="num text-ink-2">{ask ? fmtPer(ask, tokenOf(tokens, p.quote)) : "—"}</span>;
      },
    },
    { key: "n", header: "Rounds", end: true, wide: true, cell: (p) => <span className="num text-ink-2">{roundsDone(p)}</span> },
    { key: "o", header: "Outstanding", end: true, wide: true, cell: (p) => <span className="num text-ink-2">{supplies?.[p.id] ? fmtToken(supplies[p.id]!.r, tokenOf(tokens, p.asset) && { ...tokenOf(tokens, p.asset)!, symbol: shown(p, p.asset).symbol ?? "" }, true, { compact: true }) : "—"}</span> },
    {
      key: "st",
      header: "Status",
      end: true,
      cell: (p) => {
        const s = poolState(p, now, block);
        return (
          <span className="inline-flex flex-wrap items-center justify-end gap-2" title={stateWord(p, now, block, spb)}>
            {!p.graduated && s !== "closed" && <Pill>New</Pill>}
            <Pill tone={s === "open" ? "good" : s === "paused" ? "warn" : "neutral"}>{s === "open" ? `Open · ${fmtWait(nextRoundAt(p, now) - now)}` : s === "paused" ? "Paused" : s === "window" || s === "awaiting" ? "Repaying" : s === "closing" ? "Closing" : "Closed"}</Pill>
          </span>
        );
      },
    },
  ];
  const template = "minmax(150px,1.1fr) minmax(90px,0.7fr) minmax(130px,1fr) minmax(90px,0.7fr) minmax(70px,0.5fr) minmax(110px,0.8fr) minmax(150px,1fr)";

  return (
    <div>
      <h1 className="text-amount font-semibold">Markets</h1>
      <p className="mt-2 text-body text-ink-2">Every market on {networkName(meta)}, by pair and maturity. Rates are fixed to maturity and net of fees.</p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {pairs.length > 1 && (
          <div role="group" aria-label="Pair" className="flex flex-wrap gap-2">
            <Chip selected={pair === "all"} onClick={() => setPair("all")}>
              All
            </Chip>
            {pairs.map(([k, p]) => (
              <Chip key={k} selected={pair === k} onClick={() => setPair(k)}>
                {pairName(tokens, p, tw.wrapped, tw.coin, "/")}
              </Chip>
            ))}
          </div>
        )}
<button type="button" aria-pressed={showClosed} onClick={() => setClosed(!showClosed)} className="ml-auto min-h-11 text-caption text-ink-3 underline-offset-2 hover:text-ink hover:underline" data-testid="history-toggle">
          {showClosed ? "Hide past markets" : "View past markets"}
        </button>
        <Link href="/create" className="btn btn-md btn-secondary" data-testid="create-market">
          <Plus size={16} strokeWidth={1.75} aria-hidden /> Create market
        </Link>
      </div>
      {!all.some(isLive) && all.length > 0 && now > 0 && !showClosed && <p className="mt-2 text-body-sm text-ink-2">No market is open right now. Past markets are behind View past markets.</p>}
      {market && (
        <p className="mt-2 text-body-sm text-ink-2">
          Showing one market.{" "}
          <button type="button" className="link" onClick={() => setMarket(undefined)}>
            Show all
          </button>
        </p>
      )}
      <div className="mt-6 space-y-8">
        {loading || failed ? (
          <List testId="markets" loading columns={cols} template={template} rows={[]} rowKey={() => ""} error={failed ? <ErrorRow network={meta.label} onRetry={() => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === meta.id })} /> : undefined} />
        ) : groups.length === 0 ? (
          <div className="card px-6 py-5 text-body-sm text-ink-2">
            {all.length === 0 ? "No market on this network yet." : "No open market right now."}{" "}
            {!showClosed && all.length > 0 && (
              <button type="button" className="link" onClick={() => setClosed(true)}>
                Show closed
              </button>
            )}
          </div>
        ) : (
          groups.map(([id, ps]) => {
            const p0 = ps[0]!;
            const open = ps.filter((p) => poolState(p, now, block) === "open").length;
            return (
              <section key={id} aria-label={name(p0)} data-via={p0.via}>
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <span className="flex -space-x-2">
                    <TokenIcon symbol={shown(p0, p0.asset).symbol} address={shown(p0, p0.asset).address} size={28} />
                    <TokenIcon symbol={shown(p0, p0.quote).symbol} address={shown(p0, p0.quote).address} size={28} />
                  </span>
                  <h2 className="text-body font-medium">{name(p0)}</h2>
                  <span className="text-body-sm text-ink-2">{p0.kind === 0 ? "Repay any time" : "Repay at maturity"}</span>
                  {loopIds.has(p0.id) ? <Pill>Loop market</Pill> : isPegged(p0) ? <Pill>Pegged</Pill> : null}
                  <span className="text-body-sm text-ink-3">{open > 0 ? `${open} open` : "none open"}</span>
                  <SeatLink p={p0} />
                </div>
                <List testId="markets" columns={cols} template={template} rows={ps} rowKey={(p) => twinKey(p.id, p.via)} onRow={(p) => setPool(p.id, { pay: payOf(p) })} rowLabel={(p) => `${name(p)}, matures ${fmtChip(p.expiry)}`} />
              </section>
            );
          })
        )}
      </div>

      <section className="mt-12" aria-labelledby="pro-vaults">
        <h2 id="pro-vaults" className="mb-3 text-title font-medium">
          Vaults
        </h2>
        <VaultTable onOpen={setVault} />
      </section>

      <PoolDrawer id={poolId} onClose={() => setPool(undefined, { pay: undefined })} />
      <VaultDrawer address={vaultAddr} onClose={() => setVault(undefined)} />
    </div>
  );
}

function SeatLink({ p }: { p: PoolRow }) {
  const id = marketId(p.asset, p.quote, p.kind);
  const seat = useSeat({ id, asset: p.asset, quote: p.quote, kind: p.kind }).data;
  if (!seat || seat.obligation === 0n) return null;
  return (
    <Link href={`/lp?market=${id}`} className="textbtn ml-auto text-caption">
      {isVacant(seat) ? "Seat vacant" : `Seat: ${short(seat.holder)}`}
    </Link>
  );
}

export type { Tokens };
