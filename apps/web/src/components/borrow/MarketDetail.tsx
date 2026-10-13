"use client";

/**
 * One market in a wide drawer, laid out like a Uniswap token page with Pendle's two-token cards (IA v3.1 items 2, 3
 * and 9): a header with the maturity, buy-back price and repayment style; the two position tokens (C, the fixed-rate
 * token; R, the buy-back right) as cards that also pick the token in the trade card; the chart (C price, fixed rate,
 * volume or locked value; line by default, candles for the price; 1D / 1W / 1M / All); a Stats block; and beside it an
 * action card the page supplies (trade card on Borrow, loop card on Loop), plus the "Provide liquidity (LP)" entry. No
 * round-by-round mechanics here; those stay in the Markets pro view.
 */
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { formatUnits, type Hex } from "viem";
import { useConnection } from "wagmi";
import { ChevronRight, Droplets } from "lucide-react";
import { marketId } from "@confluere/sdk";
import { tokenOf, useBatchesMany, useBlockTime, usePoolSupplies, usePools, useTokens, type PoolRow, type Token } from "@/lib/data";
import { useChainClock } from "@/lib/useProduct";
import { DAY, historyOf, inRange, mergeHistory, rateKind, rateRange, volumeSince, type RangeKey } from "@/lib/history";
import { netReturn, rateShort, refToUnits } from "@/lib/quote";
import { useRefPrice } from "@/lib/refPrice";
import { lockedNow } from "@/lib/marketStats";
import { isVacant, useSeat } from "@/lib/seats";
import { isMine } from "@/lib/lp";
import { fmtChip, fmtExpiry, fmtPer, fmtToken, fmtWait, short } from "@/lib/format";
import { buyBack, lastTraded } from "@/lib/view";
import { Drawer, Pill, Segmented, Skeleton, TokenIcon, useLiveNow } from "../ui";
import { pairNote, positionAbout, POSITION, type PositionKind } from "@/lib/vocab";
import { TokenCard, useBrPrice, usePositionNames, useRepayBy } from "./positionBits";
import { PriceChart, fmtValue } from "../charts/PriceChart";
import { StatsBlock, type StatItem } from "../charts/StatsBlock";
import { stateText } from "./TokenMarketList";
import { pairName } from "@/lib/twins";
import { useTwinCtx } from "@/lib/native";
import { useSearchParams } from "next/navigation";

export function MarketDetail({
  id,
  onClose,
  side,
  initialToken = "br",
  selectable = false,
  testId = "market-drawer",
}: {
  id?: string;
  onClose: () => void;
  side: (p: { pool: PoolRow; A: Token; Q: Token; onClose: () => void; token: PositionKind; setToken: (t: PositionKind) => void }) => ReactNode;
  initialToken?: PositionKind;
  /** The token cards pick the token in the side card (Borrow's trade card). */
  selectable?: boolean;
  testId?: string;
}) {
  const [token, setToken] = useState<PositionKind>(initialToken);
  const [shownFor, setShownFor] = useState(id);
  // a newly opened market starts on the token it was opened with
  if (shownFor !== id) {
    setShownFor(id);
    setToken(initialToken);
  }
  const pools = usePools();
  const pool = id ? (pools.data ?? []).find((p) => p.id.toLowerCase() === id.toLowerCase()) : undefined;
  const tokens = useTokens(pool ? [pool.asset, pool.quote] : []).data;
  const A = tokenOf(tokens, pool?.asset);
  const Q = tokenOf(tokens, pool?.quote);
  const tw = useTwinCtx();
  // opened from a native row (?pay=native): named like the row, HYPE / USDC (the same pool)
  const via = useSearchParams()?.get("pay") === "native" ? "native" : undefined;
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={1040}
      testId={testId}
      title={pool && A && Q ? pairName(tokens, { asset: pool.asset, quote: pool.quote, via }, tw.wrapped, tw.coin) : "Market"}
    >
      {pool && A && Q ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          <MarketOverview pool={pool} A={A} Q={Q} all={pools.data ?? []} token={selectable ? token : undefined} onToken={selectable ? setToken : undefined} />
          <div className="lg:sticky lg:top-0">{side({ pool, A, Q, onClose, token, setToken })}</div>
        </div>
      ) : pools.isLoading ? (
        <div className="grid grid-cols-2 gap-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" label={i === 0 ? "Loading market" : undefined} />
          ))}
        </div>
      ) : (
        <p className="text-body-sm text-ink-2">This market is not on this network.</p>
      )}
    </Drawer>
  );
}

function MarketOverview({ pool, A, Q, all, token, onToken }: { pool: PoolRow; A: Token; Q: Token; all: PoolRow[]; token?: PositionKind; onToken?: (t: PositionKind) => void }) {
  const { now: cn, block } = useChainClock();
  const { address } = useConnection();
  const now = useLiveNow() || cn;
  const spb = useBlockTime().data;
  const sup = usePoolSupplies([pool.id]).data?.[pool.id];
  const ref = useRefPrice(pool.asset, pool.quote).data;
  const mkt = useMemo(() => ({ id: marketId(pool.asset, pool.quote, pool.kind) as Hex, asset: pool.asset, quote: pool.quote, kind: pool.kind }), [pool.asset, pool.quote, pool.kind]);
  const seat = useSeat(mkt).data;
  // the same buy-back price in the same market across maturities: the chart draws one price line per maturity
  const siblings = useMemo(
    () => all.filter((p) => p.asset.toLowerCase() === pool.asset.toLowerCase() && p.quote.toLowerCase() === pool.quote.toLowerCase() && p.kind === pool.kind && buyBack(p) === buyBack(pool)),
    [all, pool],
  );
  const ids = useMemo(() => siblings.map((p) => p.id as Hex), [siblings]);
  const batches = useBatchesMany(ids);
  const clock = { now, head: block, spb };
  const mine = historyOf(pool, batches.data[pool.id] ?? [], Q.decimals, clock);
  const merged = mergeHistory(siblings.map((p) => historyOf(p, batches.data[p.id] ?? [], Q.decimals, clock)));
  const [scope, setScope] = useState<"one" | "all">();
  const [range, setRange] = useState<RangeKey>("all");
  const sc = scope ?? (mine.length >= 3 || siblings.length < 2 ? "one" : "all");
  const points = sc === "one" ? mine : merged;
  const f = netReturn(pool, now);
  const kind = rateKind(points, pool.expiry);
  const rr = rateRange(inRange(points, range, now), kind);
  const locked = lockedNow([pool], refToUnits(ref, Q.decimals));
  const vacant = !seat || isVacant(seat);
  const lpMine = isMine(seat, address);
  const rangeLabel = range === "all" ? "all time" : range.toUpperCase();
  const names = usePositionNames(pool, A, Q);
  const br = useBrPrice(pool, Q);
  const until = useRepayBy(pool);
  const stats: StatItem[] = [
    {
      k: "Locked value",
      v: locked.value !== undefined ? fmtToken(locked.value, Q, true, { compact: true }) : fmtToken(locked.quote, Q, true, { compact: true }),
      note:
        locked.value !== undefined
          ? `${fmtToken(locked.asset, A, true, { compact: true })} + ${fmtToken(locked.quote, Q, true, { compact: true })}; collateral at the reference price, display only`
          : `plus ${fmtToken(locked.asset, A, true, { compact: true })}; no reference price`,
    },
    { k: "24h volume", v: fmtValue(volumeSince(points, now - DAY), "volume", Q.symbol) },
    { k: "Fixed rate now", v: f.priced ? rateShort(f) : "—", note: f.showApr || !f.priced ? "if repaid, after fees" : pool.expiry > now ? `for ${fmtWait(pool.expiry - now)}, if repaid` : "to maturity, if repaid" },
    { k: `High / low rate, ${rangeLabel}`, v: rr ? `${fmtValue(rr.hi, "rate", "")} / ${fmtValue(rr.lo, "rate", "")}` : "—" },
    { k: "Matures", v: fmtChip(pool.expiry), note: pool.expiry > now ? `UTC, in ${fmtWait(pool.expiry - now)}` : `UTC. ${stateText(pool, now, block)}` },
    { k: "Buy-back price", v: fmtPer(buyBack(pool), Q), note: `${Q.symbol} per ${A.symbol}` },
    { k: "C price", v: lastTraded(pool) > 0n ? fmtPer(lastTraded(pool), Q) : "No trades", note: `${Q.symbol} per C, last round` },
    { k: "R price", v: br.price ? fmtPer(br.price, Q) : "No offers", note: br.estimate ? `${Q.symbol} per R, estimated` : `${Q.symbol} per R, cheapest offer` },
    { k: "Size", v: sup ? fmtToken(sup.r, A, true, { compact: true }) : "—", note: `${A.symbol} not yet bought back` },
    { k: "LP price", v: vacant ? "Free to take" : fmtToken(seat!.price, Q), note: vacant ? "no LP right now" : lpMine ? "you are the LP" : `held by ${short(seat!.holder)}` },
  ];
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center gap-2" data-testid="market-tags">
        <span className="mr-1 flex flex-none -space-x-2" aria-hidden>
          <TokenIcon symbol={A.symbol} address={A.address} size={28} />
          <TokenIcon symbol={Q.symbol} address={Q.address} size={28} />
        </span>
        <Pill>
          Matures {fmtExpiry(pool.expiry)}
          {pool.expiry > now ? ` · in ${fmtWait(pool.expiry - now)}` : ""}
        </Pill>
        <Pill>
          Buy back at {fmtPer(buyBack(pool), Q)} {Q.symbol}
        </Pill>
        <Pill>{pool.kind === 0 ? "Repay any time" : "Repay at maturity only"}</Pill>
      </div>
      <div>
        <div className="grid gap-2 sm:grid-cols-2" data-testid="token-cards">
          {(["ft", "br"] as const).map((t) => (
            <TokenCard key={t} t={t} pool={pool} A={A} Q={Q} name={names[t]} now={now} block={block} selected={token === t} onSelect={onToken ? () => onToken(t) : undefined} />
          ))}
        </div>
        <p className="mt-2 text-caption text-ink-3">{pairNote(A.symbol)}</p>
      </div>
      <div className="card px-4 py-4 sm:px-5">
        {batches.isLoading && points.length === 0 ? (
          <Skeleton className="h-[300px] w-full" label="Loading price history" />
        ) : (
          <PriceChart
            points={points}
            expiry={pool.expiry}
            quote={Q.symbol}
            now={now}
            title="C price"
            range={range}
            onRange={setRange}
            buyBackPrice={Number(formatUnits(buyBack(pool), Q.decimals))}
            focusPool={pool.id}
            scope={sc === "all" ? `All maturities with a ${fmtPer(buyBack(pool), Q)} buy-back price` : "This maturity"}
          />
        )}
        {siblings.length > 1 && (
          <div className="mt-3">
            <Segmented
              label="Chart covers"
              value={sc}
              onChange={setScope}
              options={[
                { value: "one", label: "This maturity" },
                { value: "all", label: `All ${siblings.length} maturities` },
              ]}
            />
          </div>
        )}
      </div>
      <StatsBlock items={stats} testId="market-stats" />
      <div className="grid gap-2 sm:grid-cols-2" data-testid="position-explainer">
        {(["ft", "br"] as const).map((t) => (
          <div key={t} className="well px-4 py-3">
            <p className="text-body-sm font-medium text-ink">
              {POSITION[t].prefix}, {POSITION[t].display.toLowerCase()}
            </p>
            <p className="mt-1 text-caption text-ink-2">
              {positionAbout(t, pool, A, Q, { net: f.netPerUnit, until: until.text })} {t === "ft" ? "Lending gets you C." : "Borrowing gets you R."}
            </p>
          </div>
        ))}
      </div>
      <ProvideLiquidity marketId={mkt.id} pair={`${A.symbol} / ${Q.symbol}`} />
      <p className="text-caption text-ink-3">
        Prices form once per round, one price for everyone.{" "}
        <Link href={`/markets?pool=${pool.id}`} className="link">
          Round-by-round details
        </Link>
      </p>
    </div>
  );
}

/** "Provide liquidity (LP)" entry (IA v3.1 item 8): opens this market's LP slot on /lp. */
export function ProvideLiquidity({ marketId: id, pair, className = "" }: { marketId: string; pair: string; className?: string }) {
  return (
    <Link href={`/lp?market=${id}`} className={`card flex items-center gap-3 px-4 py-3 transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-[var(--shadow-overlay)] ${className}`} data-testid="provide-liquidity">
      <Droplets size={20} strokeWidth={1.75} className="flex-none text-brand" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-body-sm font-medium text-ink">Provide liquidity (LP)</span>
        <span className="block text-caption text-ink-2">Hold the {pair} LP slot: keep an order in every round and earn part of this market&apos;s income.</span>
      </span>
      <ChevronRight size={18} strokeWidth={1.75} className="flex-none text-ink-3" aria-hidden />
    </Link>
  );
}
