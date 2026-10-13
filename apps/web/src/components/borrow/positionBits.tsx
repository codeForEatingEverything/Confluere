"use client";

/**
 * Shared pieces for the two position tokens of a market (C, the lender token; R, the buy-back right): their names
 * for one pool, the repayment deadline a R runs to, the current prices, and the token card of the market drawer. Names
 * come from lib/vocab `positionName` only.
 */
import { useMemo } from "react";
import { useActiveChain } from "@/lib/activeChain";
import { useBlockTime, usePools, type PoolRow, type Token } from "@/lib/data";
import { repayDeadline } from "@/lib/deadline";
import { useDemo } from "@/lib/demo/mode";
import { sellPrice } from "@/lib/demo/sell";
import { fmtExpiry, fmtPer, pct } from "@/lib/format";
import { netReturn } from "@/lib/quote";
import { useRefPrice } from "@/lib/refPrice";
import { tradable, useBestOffers } from "@/lib/secondary";
import { useChainClock } from "@/lib/useProduct";
import { buyBack, lastTraded } from "@/lib/view";
import { breakEven, positionAbout, positionName, POSITION, type PositionKind, type PositionName } from "@/lib/vocab";
import { PositionIcon } from "../ui";

/** C and R names of one pool (the network's pool list decides whether the time goes into the symbol). */
export function usePositionNames(pool: PoolRow, A: Token, Q: Token): Record<PositionKind, PositionName> {
  const all = usePools().data;
  return useMemo(() => {
    const ctx = { all: all ?? [] };
    return { ft: positionName("ft", pool, A, Q, ctx), br: positionName("br", pool, A, Q, ctx) };
  }, [pool, A, Q, all]);
}

/** When a R of this pool stops working (end of the repayment window), as "Fri 16 Oct, ≈ 10:00 UTC". */
export function useRepayBy(pool: PoolRow): { ts: number; known: boolean; text: string } {
  const { now, block } = useChainClock();
  const spb = useBlockTime().data;
  const { deployment } = useActiveChain();
  const d = repayDeadline(pool, { now, block, spb, windowBlocks: deployment?.windowBlocks ?? 0 });
  const s = fmtExpiry(d.ts);
  return { ts: d.ts, known: d.known, text: d.approx ? s.replace(/, (\d)/, ", ≈ $1") : s };
}

/**
 * The R price: the cheapest listing in the holder market. The demo network has no holder market; it sells R at the
 * reference price minus the C price (lib/demo/sell), so that is shown there, marked as an estimate.
 */
export function useBrPrice(pool: PoolRow, Q: Token): { price?: bigint; estimate: boolean } {
  const demo = useDemo();
  const best = useBestOffers(demo ? [] : [pool.id as `0x${string}`]).data?.[pool.id.toLowerCase()];
  const ref = useRefPrice(pool.asset, pool.quote).data;
  if (demo) {
    const p = sellPrice("r", pool.lastClearingPrice, ref, Q.decimals);
    return { price: p > 0n ? p : undefined, estimate: true };
  }
  return { price: best?.brAsk, estimate: false };
}

/** "9.12% fixed APR" for terms of a day or more, "+0.40% this term" below (an APR of a short term misleads). */
export function fixedWords(f: { period: number; apr: number; showApr: boolean }): string {
  return f.showApr ? `${pct(f.apr)} fixed APR` : `+${pct(f.period)} this term`;
}

/** Icon, full symbol and display name in one line. */
export function PositionTitle({ t, name, A, size = 28, faded, expired, className = "" }: { t: PositionKind; name: PositionName; A: Token; size?: number; faded?: boolean; expired?: boolean; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-2.5 ${className}`}>
      <PositionIcon t={t} asset={A} size={size} faded={faded} expired={expired} />
      <span className="min-w-0">
        <span className="num block text-body-sm font-semibold text-ink [overflow-wrap:anywhere]" title={name.symbol}>
          {name.symbol}
        </span>
        <span className="block text-caption text-ink-2">
          {name.display}
          {expired ? " · Expired" : faded ? " · Matured" : ""}
        </span>
      </span>
    </span>
  );
}

/** One of the two token cards under the drawer header: name, price, and what one token does. A click picks it in the trade card. */
export function TokenCard({ t, pool, A, Q, name, selected, onSelect, now, block }: { t: PositionKind; pool: PoolRow; A: Token; Q: Token; name: PositionName; selected?: boolean; onSelect?: () => void; now: number; block: bigint }) {
  const until = useRepayBy(pool);
  const br = useBrPrice(pool, Q);
  const bb = buyBack(pool);
  const f = netReturn(pool, now);
  const isR = t === "br";
  const live = now === 0 || tradable(pool, isR, now, block);
  const body = isR ? (
    <>
      <p className="num mt-3 text-title font-semibold text-ink">{br.price ? `${br.estimate ? "≈ " : ""}${fmtPer(br.price, Q)} ${Q.symbol}` : <span className="text-ink-3">No offers yet</span>}</p>
      <p className="mt-1 text-caption text-ink-2">
        Buy 1 {A.symbol} for {fmtPer(bb, Q)} {Q.symbol} {pool.kind === 1 ? `between maturity and ${until.text}` : `until ${until.text}`}
      </p>
      <p className="num mt-1 text-caption text-ink-2">{br.price ? `Break-even: ${A.symbol} above ${fmtPer(breakEven(bb, br.price), Q)}` : `Worth nothing after ${until.text}`}</p>
    </>
  ) : (
    <>
      <p className="num mt-3 text-title font-semibold text-ink">{lastTraded(pool) > 0n ? `${fmtPer(lastTraded(pool), Q)} ${Q.symbol}` : <span className="text-ink-3">No trades yet</span>}</p>
      <p className="mt-1 text-caption text-ink-2">
        {f.priced ? (
          <>
            <strong className="font-semibold text-ink">{fixedWords(f)}</strong> if repaid
          </>
        ) : (
          "Fixed rate shows after the first trade"
        )}
      </p>
      <p className="num mt-1 text-caption text-ink-2">
        Pays {f.priced ? "" : "up to "}
        {fmtPer(f.netPerUnit || bb, Q)} {Q.symbol} or 1 {A.symbol} at maturity
      </p>
    </>
  );
  const cls = `card block w-full px-4 py-4 text-left transition-[box-shadow] duration-150 ${selected ? "shadow-[inset_0_0_0_1.5px_var(--brand),var(--shadow-card)]" : ""}`;
  const inner = (
    <>
      <PositionTitle t={t} name={name} A={A} faded={!isR && !live} expired={isR && !live} />
      {body}
      <p className="sr-only">{positionAbout(t, pool, A, Q, { net: f.netPerUnit, until: until.text })}</p>
    </>
  );
  return onSelect ? (
    <button type="button" className={cls} aria-pressed={!!selected} onClick={onSelect} data-testid={`token-card-${t}`} title={`${POSITION[t].display}: ${positionAbout(t, pool, A, Q, { net: f.netPerUnit, until: until.text })}`}>
      {inner}
    </button>
  ) : (
    <div className={cls} data-testid={`token-card-${t}`}>
      {inner}
    </div>
  );
}
