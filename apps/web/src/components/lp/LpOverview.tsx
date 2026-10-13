"use client";

/**
 * Left column of an LP market (IA v3.1 item 8, Uniswap token page): the chart on top (price, volume or locked value,
 * 1D / 1W / 1M / All) and a Stats block under it: locked value, 24h volume, current rate, the range's high and low rate,
 * the LP's price and holder, the tax rate and the bond. Then the LP's duties in plain words, and a way for anyone to
 * report a missed round.
 */
import { useMemo, useState } from "react";
import { useConnection } from "wagmi";
import type { Hex } from "viem";
import { useActiveChain } from "@/lib/activeChain";
import { useBatchesMany, useBlockTime, type Token } from "@/lib/data";
import { tradingPools, type Market } from "@/lib/markets";
import { useChainClock } from "@/lib/useProduct";
import { DAY, historyOf, inRange, mergeHistory, rateKind, rateRange, volumeSince, type RangeKey } from "@/lib/history";
import { lockedNow } from "@/lib/marketStats";
import { netReturn, rateShort, refToUnits } from "@/lib/quote";
import { useRefPrice } from "@/lib/refPrice";
import { bondOf, isVacant, useRegistryParams, useSeat } from "@/lib/seats";
import { isMine } from "@/lib/lp";
import { slashEvidence } from "@/lib/due";
import { buyBack } from "@/lib/view";
import { seatReportWrite } from "@/lib/proActions";
import { fmtPer, fmtToken, short } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { Button, Skeleton, TxErrorLine, useLiveNow } from "../ui";
import { PriceChart, fmtValue } from "../charts/PriceChart";
import { StatsBlock, type StatItem } from "../charts/StatsBlock";

export function LpOverview({ m, A, Q }: { m: Market; A: Token; Q: Token }) {
  const { deployment } = useActiveChain();
  const { address } = useConnection();
  const { now: cn, block } = useChainClock();
  const now = useLiveNow() || cn;
  const spb = useBlockTime().data;
  const ids = useMemo(() => m.pools.map((p) => p.id as Hex), [m.pools]);
  const batches = useBatchesMany(ids);
  const clock = { now, head: block, spb };
  const all = m.pools.map((p) => ({ p, h: historyOf(p, batches.data[p.id] ?? [], Q.decimals, clock) }));
  // the price view: the buy-back level with the most traded rounds (levels differ in price), one line per maturity
  const byLevel = new Map<string, number>();
  for (const x of all) byLevel.set(String(buyBack(x.p)), (byLevel.get(String(buyBack(x.p))) ?? 0) + x.h.length);
  const level = [...byLevel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const levelPool = m.pools.find((p) => String(buyBack(p)) === level);
  const levelPrice = levelPool ? buyBack(levelPool) : undefined;
  const points = mergeHistory(all.filter((x) => String(buyBack(x.p)) === level).map((x) => x.h));
  const everything = mergeHistory(all.map((x) => x.h));
  const [range, setRange] = useState<RangeKey>("all");
  const seat = useSeat(m).data;
  const params = useRegistryParams().data;
  const ref = useRefPrice(m.asset, m.quote).data;
  const locked = lockedNow(m.pools, refToUnits(ref, Q.decimals));
  const open = tradingPools(m, now);
  const current = open.find((p) => p.lastClearingPrice > 0n) ?? [...m.pools].reverse().find((p) => p.lastClearingPrice > 0n);
  const f = current ? netReturn(current, now) : undefined;
  const kind = rateKind(points, current?.expiry ?? now + DAY);
  const rr = rateRange(inRange(everything, range, now), kind);
  const vacant = !seat || isVacant(seat);
  const mine = isMine(seat, address);
  const evidence = seat && !vacant && deployment ? slashEvidence(m.pools, deployment.gridAnchor, deployment.batchInterval, seat.lastQuotedBatch, now) : undefined;
  const rangeLabel = range === "all" ? "all time" : range.toUpperCase();

  const stats: StatItem[] = [
    {
      k: "Locked value",
      v: locked.value !== undefined ? fmtToken(locked.value, Q, true, { compact: true }) : fmtToken(locked.quote, Q, true, { compact: true }),
      note: locked.value !== undefined ? `${fmtToken(locked.asset, A, true, { compact: true })} + ${fmtToken(locked.quote, Q, true, { compact: true })}; collateral at the reference price, display only` : `plus ${fmtToken(locked.asset, A, true, { compact: true })}`,
    },
    { k: "24h volume", v: fmtValue(volumeSince(everything, now - DAY), "volume", Q.symbol) },
    { k: "Current rate", v: f?.priced ? rateShort(f) : "—", note: current ? "fixed, if repaid, soonest open maturity" : "no trades yet" },
    { k: `High / low rate, ${rangeLabel}`, v: rr ? `${fmtValue(rr.hi, "rate", "")} / ${fmtValue(rr.lo, "rate", "")}` : "—" },
    { k: "LP price", v: vacant ? "Free to take" : fmtToken(seat!.price, Q), note: vacant ? "no LP right now" : "anyone can take the slot at this price" },
    { k: "Holder", v: vacant ? "None" : mine ? "You" : short(seat!.holder), mono: !vacant && !mine },
    { k: "Tax rate", v: params ? `${params.tax / 100}% a year` : "—", note: "of the LP's own price, taken every second" },
    { k: "Bond", v: seat ? fmtToken(bondOf(seat), Q) : "—", note: "returned on exit; 20% lost on a missed round" },
  ];

  return (
    <div className="min-w-0 space-y-6">
      <div className="card px-4 py-4 sm:px-5">
        {batches.isLoading && everything.length === 0 ? (
          <Skeleton className="h-[300px] w-full" label="Loading history" />
        ) : (
          <PriceChart points={points} expiry={current?.expiry ?? now + DAY} quote={Q.symbol} now={now} metrics={["price", "volume", "locked"]} flowPoints={everything} range={range} onRange={setRange} focusPool={current?.id} scope={levelPrice !== undefined ? `Buy-back price ${fmtPer(levelPrice, Q)}, all maturities` : "All maturities"} testId="lp-chart" />
        )}
      </div>
      <StatsBlock items={stats} testId="lp-stats" />
      <section className="well px-4 py-4 text-body-sm text-ink-2" data-testid="lp-duties">
        <p className="font-medium text-ink">What the LP does</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Keeps an order near the market price in every round, worth at least {seat ? fmtToken(seat.obligation, Q) : "the minimum"}. The order can&apos;t be cancelled before its round.</li>
          <li>A missed round costs 20% of the bond and the slot.</li>
          <li>Earns {params ? `${params.share / 100}%` : "a share"} of the market&apos;s protocol income, plus the interest on its own fills.</li>
          <li>Pays {params ? `${params.tax / 100}%` : "a share"} of its own price per year as tax, from the prepaid tax.</li>
        </ul>
      </section>
      {!mine && evidence && seat && <ReportMissed evidence={evidence} round={seat.lastQuotedBatch + 1} />}
    </div>
  );
}

/** Anyone may report an LP that skipped a round; the slot becomes free. */
function ReportMissed({ evidence, round }: { evidence: { id: `0x${string}` }; round: number }) {
  const { deployment } = useActiveChain();
  const tx = useTx();
  if (!deployment?.seatRegistry) return null;
  return (
    <section className="space-y-2" data-testid="lp-report">
      <p className="text-body-sm text-ink-2">The LP did not keep an order in round {round}. Anyone can report it; the slot becomes free.</p>
      <Button size="md" variant="secondary" loading={tx.busy} onClick={() => void tx.run([seatReportWrite(deployment.seatRegistry!, evidence)])}>
        Report a missed round
      </Button>
      <TxErrorLine error={tx.lastError} />
    </section>
  );
}

