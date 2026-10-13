"use client";

/**
 * Loop (IA v3.1 item 3): the same list and drawer as Borrow, for the markets a loop works in: those that repay any time
 * on the network's own coin (WHYPE / WMON collateral, paid in HYPE / MON if you like) or on a staked version of it.
 * Pick any of them; the drawer shows the chart beside the loop calculator and its action card. Monad and HyperEVM are
 * symmetric: an empty network never points to the other one.
 */
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveChain } from "@/lib/activeChain";
import { usePoolSupplies, usePools, useTokens } from "@/lib/data";
import { useChainClock } from "@/lib/useProduct";
import { loopMarkets } from "@/lib/loop";
import { isPegged } from "@/lib/markets";
import { networkName } from "@/lib/vocab";
import { useQueryParam } from "@/lib/url";
import { useBestOffers } from "@/lib/secondary";
import { Chip, EmptyState, ErrorRow, useLiveNow } from "../ui";
import { LoopCard } from "../borrow/LoopCard";
import { MarketDetail } from "../borrow/MarketDetail";
import { TokenMarketList } from "../borrow/TokenMarketList";
import { pairChips, useMarketRows } from "../borrow/BorrowMarkets";
import { pairName, payOf, type Via } from "@/lib/twins";
import { useTwinCtx } from "@/lib/native";

export function LoopScreen() {
  const { meta } = useActiveChain();
  const qc = useQueryClient();
  const tw = useTwinCtx();
  const [poolId, setPool] = useQueryParam("pool");
  const open = (id: string, _t?: unknown, via?: Via, twin?: boolean) => setPool(id, { pay: payOf({ via, twin }) });
  const [pair, setPair] = useState("all");
  const [closed, setClosed] = useState(false);
  const pools = usePools();
  const { block } = useChainClock();
  const now = useLiveNow();
  const loopPools = useMemo(() => loopMarkets(pools.data ?? [], meta.id), [pools.data, meta.id]);
  const tokens = useTokens(useMemo(() => [...new Set(loopPools.flatMap((p) => [p.asset, p.quote]))] as Address[], [loopPools])).data;
  const supplies = usePoolSupplies(loopPools.map((p) => p.id)).data;
  const offers = useBestOffers(useMemo(() => loopPools.map((p) => p.id as `0x${string}`), [loopPools])).data;
  const m = useMarketRows(loopPools, { pair, style: "all", closed, now, block, wrapped: tw.wrapped });
  const { live, showClosed } = m;
  // the staked coin's market first, then the coin's own (lib/loop loopMarkets order), each by maturity
  const rows = useMemo(() => [...m.rows].sort((a, b) => Number(isPegged(b)) - Number(isPegged(a))), [m.rows]);
  const pairs = pairChips(loopPools, tw.wrapped);
  const loading = pools.isLoading || now === 0 || (loopPools.length > 0 && !tokens);
  const failed = !pools.data && (pools.isError || pools.discovering);

  return (
    <div>
      <h1 className="text-amount font-semibold">Loop</h1>
      <p className="mt-2 max-w-[70ch] text-body text-ink-2">
        Borrow against {meta.native}, turn what you receive back into {meta.native}
        {loopPools.some(isPegged) ? " (or its staked version)" : ""}, and borrow again. Each round is an ordinary fixed-rate loan at the same maturity, so there is no liquidation price; you repay or roll over at maturity.
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
        {loopPools.length > 0 && (
          <label className="ml-auto flex min-h-11 items-center gap-2 text-body-sm text-ink-2">
            <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={showClosed} onChange={(e) => setClosed(e.target.checked)} />
            Show matured
          </label>
        )}
      </div>

      <div className="mt-4">
        {loading || failed ? (
          <TokenMarketList testId="loop-markets" rows={[]} tokens={tokens} now={now} block={block} onOpen={open} loading error={failed && pools.isError ? <ErrorRow network={meta.label} onRetry={() => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === meta.id })} /> : undefined} />
        ) : loopPools.length === 0 ? (
          <div className="card px-6 py-1">
            <NoLoopMarkets />
          </div>
        ) : (
          <>
            {live.length === 0 && <p className="mb-3 text-body-sm text-ink-2">No loop market is open right now; matured ones are shown, newest first.</p>}
            <TokenMarketList testId="loop-markets" rows={rows} tokens={tokens} now={now} block={block} supplies={supplies} offers={offers} onOpen={open} />
          </>
        )}
      </div>

      <MarketDetail id={poolId} onClose={() => setPool(undefined, { pay: undefined })} testId="loop-drawer" side={({ pool, A, Q }) => <LoopCard pool={pool} A={A} Q={Q} />} />
    </div>
  );
}

/** "No loop markets on HyperEVM Testnet." What a loop needs; never a hop to the other network (they are symmetric). */
function NoLoopMarkets() {
  const { meta } = useActiveChain();
  return <EmptyState title={`No loop markets on ${networkName(meta)}`} body={`A loop needs a market on ${meta.native} or a staked ${meta.native} that repays any time. The next one opens soon.`} />;
}
