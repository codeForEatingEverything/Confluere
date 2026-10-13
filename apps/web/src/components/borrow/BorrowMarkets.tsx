"use client";

/**
 * Borrow (IA v3.1 item 2): every pool as a pair of position tokens, Pendle PT / YT style. C, the lender token, is
 * the lender's side; R, the buy-back right, the borrower's. The list shows the C price with its fixed rate, the R
 * price with its break-even, the buy-back price and the size; a row opens the market drawer with the token cards, the
 * chart and the trade card (?pool=, shareable; ?token=ft|br and ?trade=lend pick the token).
 */
import { latestMaturities } from "@/lib/markets";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Address } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { Kind, Status } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { usePoolSupplies, usePools, useTokens, type PoolRow } from "@/lib/data";
import { useChainClock } from "@/lib/useProduct";
import { buyBack, poolState } from "@/lib/view";
import { useQueryParam } from "@/lib/url";
import { pairKey, pairName, payOf, poolTwins, type Via } from "@/lib/twins";
import { useTwinCtx } from "@/lib/native";
import { useBestOffers } from "@/lib/secondary";
import type { PositionKind } from "@/lib/vocab";
import { Chip, ErrorRow, Segmented, useLiveNow } from "../ui";
import { NothingOpen } from "./BorrowEmpty";
import { MarketDetail } from "./MarketDetail";
import { TokenMarketList, MARKET_TEMPLATE, marketColumns } from "./TokenMarketList";
import { TradeCard, type TradeAction } from "./TradeCard";

type StyleFilter = "all" | "0" | "1";

/**
 * Filter row + list over a set of pools; shared by Borrow and Loop. Every pool touching the wrapped coin is listed twice
 * (lib/twins): its native pairing (HYPE / USDC) right before the on-chain one (WHYPE / USDC). `pair` is a `pairKey`.
 */
export function useMarketRows(pools: PoolRow[], o: { pair: string; style: StyleFilter; closed: boolean; now: number; block: bigint; wrapped: string | undefined }) {
  const isLive = (p: PoolRow) => poolState(p, o.now, o.block) !== "closed" && p.expiry > o.now;
  const live = pools.filter(isLive);
  // default view: live pools only, three maturities per pair at most; past markets only behind the history button
  const showClosed = o.closed;
  const sorted = (showClosed ? pools : latestMaturities(live, isLive))
    .filter((p) => o.style === "all" || String(p.kind) === o.style)
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || (isLive(a) ? a.expiry - b.expiry : b.expiry - a.expiry) || (buyBack(a) < buyBack(b) ? -1 : buyBack(a) > buyBack(b) ? 1 : a.kind - b.kind));
  const rows = poolTwins(sorted, o.wrapped).filter((p) => o.pair === "all" || pairKey(p) === o.pair);
  return { rows, live, showClosed };
}

/** The pair chips: every pairing once (HYPE / USDC and WHYPE / USDC are two chips), keyed by `pairKey`. */
export const pairChips = <P extends { asset: string; quote: string }>(pools: P[], wrapped: string | undefined) => [...new Map(poolTwins(pools, wrapped).map((p) => [pairKey(p), p])).entries()];

export function BorrowMarkets() {
  const params = useSearchParams();
  const { meta } = useActiveChain();
  const qc = useQueryClient();
  const tw = useTwinCtx();
  const [poolId, setPool] = useQueryParam("pool");
  const [pair, setPair] = useState("all");
  const [style, setStyle] = useState<StyleFilter>(params?.get("style") === "european" ? "1" : "all");
  const [closed, setClosed] = useState(params?.get("closed") === "1");
  const pools = usePools();
  const { block } = useChainClock();
  const now = useLiveNow();
  const all = useMemo(() => pools.data ?? [], [pools.data]);
  const tokens = useTokens(useMemo(() => [...new Set(all.flatMap((p) => [p.asset, p.quote]))] as Address[], [all])).data;
  const supplies = usePoolSupplies(all.map((p) => p.id)).data;
  const offers = useBestOffers(useMemo(() => all.filter((p) => p.status !== Status.Closed).map((p) => p.id as `0x${string}`), [all])).data;
  const { rows, live, showClosed } = useMarketRows(all, { pair, style, closed, now, block, wrapped: tw.wrapped });
  const pairs = pairChips(all, tw.wrapped);
  const kinds = new Set(all.map((p) => p.kind));
  const loading = pools.isLoading || now === 0 || (all.length > 0 && !tokens);
  const failed = !pools.data && (pools.isError || pools.discovering);
  const [picked, setPicked] = useState<PositionKind>();
  const tokenParam = params?.get("token");
  const lendLink = params?.get("trade") === "lend";
  const initialToken: PositionKind = picked ?? (tokenParam === "ft" || tokenParam === "br" ? tokenParam : lendLink ? "ft" : "br");
  const actionParam = params?.get("action");
  const initialAction = (["lend", "borrow", "buy", "sell", "repay"] as const).find((a) => a === actionParam) as TradeAction | undefined;
  const open = (id: string, t?: PositionKind, via?: Via, twin?: boolean) => {
    setPicked(t);
    setPool(id, { pay: payOf({ via, twin }) });
  };

  return (
    <div>
      <h1 className="text-amount font-semibold">Borrow markets</h1>
      <p className="mt-2 max-w-[70ch] text-body text-ink-2">
        Every loan here is two tokens. <strong className="font-medium text-ink">R</strong>, the buy-back right, is what a borrower holds: it buys the collateral back at a fixed price before the deadline.{" "}
        <strong className="font-medium text-ink">C</strong>, the lender token, is what a lender holds: it pays that price at maturity, or the collateral if the borrower walks away. Borrow to get R, lend to get C, or trade either with
        other holders.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {pairs.length > 1 && (
          <div role="group" aria-label="Pair" className="flex flex-wrap gap-2">
            <Chip selected={pair === "all"} onClick={() => setPair("all")}>
              All
            </Chip>
            {pairs.map(([k, p]) => (
              <Chip key={k} selected={pair === k} onClick={() => setPair(k)}>
                {pairName(tokens, p, tw.wrapped, tw.coin)}
              </Chip>
            ))}
          </div>
        )}
        {kinds.has(Kind.American) && kinds.has(Kind.European) && (
          <Segmented
            label="Repayment"
            value={style}
            onChange={setStyle}
            options={[
              { value: "all", label: "All" },
              { value: "0", label: "Any time" },
              { value: "1", label: "At maturity" },
            ]}
          />
        )}
<button type="button" aria-pressed={showClosed} onClick={() => setClosed(!showClosed)} className="ml-auto min-h-11 text-caption text-ink-3 underline-offset-2 hover:text-ink hover:underline" data-testid="history-toggle">
          {showClosed ? "Hide past markets" : "View past markets"}
        </button>
      </div>

      <div className="mt-4">
        {loading || failed ? (
          <TokenMarketList rows={[]} tokens={tokens} now={now} block={block} onOpen={open} loading error={failed && pools.isError ? <ErrorRow network={meta.label} onRetry={() => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === meta.id })} /> : undefined} />
        ) : (
          <>
            {live.length === 0 && all.length > 0 && (
              <div className="card mb-6 px-6 py-1">
                <NothingOpen what="borrow" closedLink={false} closedTerms={new Set(all.map((p) => p.expiry)).size} lastExpiry={Math.max(0, ...all.map((p) => p.expiry)) || undefined} />
              </div>
            )}
            {rows.length === 0 ? (
              <p className="py-4 text-body-sm text-ink-2">{all.length === 0 ? `No market on ${meta.label} yet.` : "Nothing matches these filters."}</p>
            ) : (
              <>
                {live.length === 0 && <p className="mb-3 text-body-sm text-ink-2">Matured markets, newest first. Open one to see its price history.</p>}
                <TokenMarketList rows={rows} tokens={tokens} now={now} block={block} supplies={supplies} offers={offers} onOpen={open} />
              </>
            )}
          </>
        )}
      </div>

      <MarketDetail
        id={poolId}
        onClose={() => setPool(undefined, { pay: undefined })}
        initialToken={initialToken}
        selectable
        side={({ pool, A, Q, onClose, token, setToken }) => <TradeCard pool={pool} A={A} Q={Q} initial={initialToken} initialAction={initialAction} token={token} onToken={setToken} onClose={onClose} />}
      />
    </div>
  );
}

export { MARKET_TEMPLATE, marketColumns };
