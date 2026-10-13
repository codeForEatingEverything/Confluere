"use client";

/**
 * Home card, Loop mode (IA v3.1 item 1): borrow, turn the loan back into the collateral, borrow again, all at one
 * maturity, from the same card. Offered only on networks with a loop market (the network's own coin, or a staked
 * version of it, in a market that repays any time). The router picks the maturity and pool, preferring the coin's own
 * market; Maturity and Pool selectors let the person choose. The loop calculator below shows the rounds, the final
 * exposure, what to repay at maturity and the worst case.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, usePools, useTokens, type PoolRow } from "@/lib/data";
import { loopMarkets } from "@/lib/loop";
import { isPegged } from "@/lib/markets";
import { isWrappedNative } from "@/lib/native";
import { useChainClock } from "@/lib/useProduct";
import { fixedReturn, rateShort } from "@/lib/quote";
import { fmtChip, fmtPer, fmtWait } from "@/lib/format";
import { buyBack, takesOrders } from "@/lib/view";
import { useLiveNow } from "../ui";
import { LoopCard } from "../borrow/LoopCard";
import { NothingOpen } from "../borrow/BorrowEmpty";
import { SwapSkeleton } from "./BorrowSwap";
import { SelectField } from "./RouteSelectors";

/** Whether the active network has any loop market at all (decides if the card offers the Loop mode). */
export function useHasLoopMarkets(): boolean {
  const { chainId } = useActiveChain();
  const pools = usePools().data ?? [];
  return loopMarkets(pools, chainId).length > 0;
}

/**
 * Loop router, pure: the asked-for maturity (else the soonest where the staked coin's market has traded, else the soonest
 * that has traded, else the soonest), then in it the staked-coin (pegged) market first, then the coin's own, priced before unpriced, then the lowest cost to borrow.
 */
export function routeLoop(open: PoolRow[], chainId: number, now: number, expiry?: number, poolId?: string) {
  const expiries = [...new Set(open.map((p) => p.expiry))].sort((a, b) => a - b);
  const tradedIn = (xs: PoolRow[]) => expiries.find((e) => xs.some((p) => p.expiry === e && p.lastClearingPrice > 0n));
  // the staked coin's market leads (pegged first), so the default term is its soonest traded one when it has one
  const pegged = open.filter(isPegged);
  const term = expiries.includes(expiry ?? -1) ? expiry! : (tradedIn(pegged) ?? tradedIn(open) ?? pegged.map((p) => p.expiry).sort((a, b) => a - b)[0] ?? expiries[0]);
  const pools = open
    .filter((p) => p.expiry === term)
    .sort(
      (a, b) =>
        Number(isPegged(b)) - Number(isPegged(a)) ||
        Number(isWrappedNative(chainId, b.asset)) - Number(isWrappedNative(chainId, a.asset)) ||
        Number(b.lastClearingPrice > 0n) - Number(a.lastClearingPrice > 0n) ||
        fixedReturn(a, now).apr - fixedReturn(b, now).apr,
    );
  const own = poolId ? pools.find((p) => p.id.toLowerCase() === poolId.toLowerCase()) : undefined;
  return { expiries, term, pools, pool: own ?? pools[0], picked: !!own };
}

export function LoopSwap() {
  const { chainId } = useActiveChain();
  const q = usePools();
  const { now: cn, block } = useChainClock();
  const now = useLiveNow() || cn;
  const [expiry, setExpiry] = useState<number>();
  const [poolPick, setPoolPick] = useState<string>();
  const all = useMemo(() => loopMarkets(q.data ?? [], chainId), [q.data, chainId]);
  const open = useMemo(() => all.filter((p) => takesOrders(p, now, block)), [all, now, block]);
  const r = routeLoop(open, chainId, now, expiry, poolPick);
  const tokens = useTokens(useMemo(() => [...new Set(all.flatMap((p) => [p.asset, p.quote]))], [all])).data;
  const sym = (a: string) => tokenOf(tokens, a)?.symbol ?? "…";

  if (q.isLoading || now === 0) return <SwapSkeleton />;
  if (!r.pool) {
    const last = Math.max(0, ...all.map((p) => p.expiry));
    return (
      <div data-testid="loop-swap">
        <NothingOpen what="loop" closedTerms={new Set(all.map((p) => p.expiry)).size} lastExpiry={last || undefined} />
      </div>
    );
  }
  const A = tokenOf(tokens, r.pool.asset);
  const Q = tokenOf(tokens, r.pool.quote);
  if (!A || !Q) return <SwapSkeleton />;
  const selectors = (
    <div>
        <div className="grid grid-cols-2 gap-2" data-testid="loop-selectors">
          <SelectField
            label="Maturity"
            title="Choose a maturity"
            value={r.term}
            onChange={(e) => {
              setExpiry(e);
              setPoolPick(undefined);
            }}
            testId="loop-maturity-select"
            display={r.term ? `${fmtChip(r.term)} UTC` : "—"}
            options={r.expiries.map((e) => ({ value: e, label: `${fmtChip(e)} UTC`, sub: e > now ? `in ${fmtWait(e - now)}` : undefined }))}
          />
          <SelectField
            label="Pool"
            title="Loop pools"
            value={r.pool.id}
            onChange={(id) => setPoolPick(id)}
            testId="loop-pool-select"
            display={`${sym(r.pool.asset)} / ${sym(r.pool.quote)}, buy back at ${Q ? fmtPer(buyBack(r.pool), Q) : ""}`}
            options={r.pools.map((p, i) => {
              const f = fixedReturn(p, now);
              const qt = tokenOf(tokens, p.quote);
              return {
                value: p.id,
                label: `${sym(p.asset)} / ${sym(p.quote)}`,
                sub: `Buy back at ${qt ? fmtPer(buyBack(p), qt) : ""}`,
                aside: f.priced ? `${rateShort(f)} to borrow` : "No trades yet",
                best: i === 0,
              };
            })}
          />
        </div>
        <p className="mt-2 text-caption text-ink-3">
          {r.picked ? "Your pick" : "Best loop pool for this date"}.{" "}
          <Link href={`/loop?pool=${r.pool.id}`} className="link">
            Details
          </Link>
        </p>
    </div>
  );
  return (
    <div data-testid="loop-swap">
      <LoopCard key={r.pool.id} pool={r.pool} A={A} Q={Q} embedded top={selectors} />
    </div>
  );
}
