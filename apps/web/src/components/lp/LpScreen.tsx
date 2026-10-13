"use client";

/**
 * LP (IA v3.1 item 8). First a list of the LP pools, one per market: the pair with the "LP" badge, the LP's price and
 * holder, the market's locked value and where the earnings come from. A row opens the market in a wide drawer laid out
 * like a Uniswap token page: chart and Stats on the left, a Pendle-style zap card on the right (Zap in, Manage,
 * Zap out) with a few plain sentences under it. Under the hood an LP slot is a SeatRegistry seat (a Harberger tax).
 */
import { useMemo } from "react";
import { useConnection } from "wagmi";
import type { Address } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, usePools, useTokens, type Token } from "@/lib/data";
import { groupMarkets, type Market } from "@/lib/markets";
import { useRegistryParams, type SeatView } from "@/lib/seats";
import { isMine, useSeats } from "@/lib/lp";
import { lockedNow } from "@/lib/marketStats";
import { refToUnits } from "@/lib/quote";
import { useRefPrice } from "@/lib/refPrice";
import { fmtToken, short } from "@/lib/format";
import { STYLE_SHORT } from "@/lib/vocab";
import { useQueryParam } from "@/lib/url";
import { Button, Drawer, EmptyState, ErrorRow, List, Pill, Skeleton, type Column } from "../ui";
import { LpIcon } from "./LpIcon";
import { payOf, poolTwins, shownToken, twinKey, type Via } from "@/lib/twins";
import { useTwinCtx } from "@/lib/native";
import { LpOverview } from "./LpOverview";
import { ZapCard } from "./ZapCard";

type Tokens = Record<string, Token> | undefined;
/** One LP slot as listed: a market touching the wrapped coin shows twice (lib/twins), HYPE / USDC then WHYPE / USDC. */
type Row = { m: Market; seat?: SeatView; via: Via; twin: boolean };
type Names = { wrapped: string | undefined; coin: string };
const shownOf = (tokens: Tokens, a: string, via: Via | undefined, n: Names) => {
  const t = tokenOf(tokens, a);
  const s = shownToken(t, a, via, n.wrapped, n.coin);
  return { address: s.address, symbol: s.symbol, token: t && s.native ? { ...t, symbol: s.symbol ?? t.symbol } : t };
};

export function LpScreen() {
  const { deployment, meta } = useActiveChain();
  const qc = useQueryClient();
  const { address } = useConnection();
  const tw = useTwinCtx();
  const pools = usePools();
  const all = useMemo(() => groupMarkets(pools.data ?? []), [pools.data]);
  const seats = useSeats(all).data;
  // only markets whose loan token has LP slots (the registry's minimum order is set for it)
  const markets = all.filter((m) => !seats || (seats[m.id]?.obligation ?? 0n) > 0n);
  const tokens = useTokens(useMemo(() => all.flatMap((m) => [m.asset, m.quote]) as Address[], [all])).data;
  const params = useRegistryParams().data;
  const [sel, setSel] = useQueryParam("market");
  const [payParam] = useQueryParam("pay");
  const m = sel ? all.find((x) => x.id.toLowerCase() === sel.toLowerCase()) : undefined;
  const A = tokenOf(tokens, m?.asset);
  const Q = tokenOf(tokens, m?.quote);
  const rows: Row[] = poolTwins(markets, tw.wrapped).map((mk) => ({ m: mk, seat: seats?.[mk.id], via: mk.via, twin: mk.twin }));
  const via: Via | undefined = payParam === "native" ? "native" : undefined;
  const title = m && A && Q ? `${shownOf(tokens, m.asset, via, tw).symbol} / ${shownOf(tokens, m.quote, via, tw).symbol} LP` : "LP";
  const share = params ? `${params.share / 100}%` : "a share";

  return (
    <div>
      <h1 className="text-amount font-semibold">LP</h1>
      <p className="mt-2 max-w-[72ch] text-body text-ink-2">
        Each market has one LP slot. The LP keeps an order in every round and earns {share} of the market&apos;s protocol income plus the interest on its own fills. You set your own price for the slot and pay a yearly tax on it; anyone can take the slot over by paying you that price.
      </p>
      <div className="mt-6">
        {!deployment?.seatRegistry ? (
          <EmptyState title="No LP slots on this network." />
        ) : (
          <List<Row>
            testId="lp-pools"
            loading={pools.isLoading || (all.length > 0 && !seats)}
            error={!pools.data && pools.isError ? <ErrorRow network={meta.label} onRetry={() => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === meta.id })} /> : undefined}
            rows={rows}
            rowKey={(r) => twinKey(r.m.id, r.via)}
            onRow={(r) => setSel(r.m.id, { pay: payOf(r) })}
            rowLabel={(r) => `Open ${shownOf(tokens, r.m.asset, r.via, tw).symbol ?? ""} / ${shownOf(tokens, r.m.quote, r.via, tw).symbol ?? ""} LP`}
            template="minmax(220px,1.4fr) minmax(120px,1fr) minmax(110px,0.9fr) minmax(130px,1fr) minmax(170px,1.2fr) auto"
            columns={lpColumns(tokens, address, share, tw)}
            empty={<EmptyState title="No market on this network yet." />}
          />
        )}
      </div>
      <Drawer open={!!sel} onClose={() => setSel(undefined, { pay: undefined })} width={1080} testId="lp-drawer" title={title} subtitle={m ? `${STYLE_SHORT[m.kind]}. One LP slot for every maturity of this market.` : undefined}>
        {m && A && Q ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
            <LpOverview m={m} A={A} Q={Q} />
            <div className="lg:sticky lg:top-0">
              <ZapCard m={m} A={A} Q={Q} />
            </div>
          </div>
        ) : pools.isLoading ? (
          <Skeleton className="h-60 w-full" label="Loading market" />
        ) : (
          <p className="text-body-sm text-ink-2">This market is not on this network.</p>
        )}
      </Drawer>
    </div>
  );
}

function lpColumns(tokens: Tokens, account: string | undefined, share: string, n: Names): Column<Row>[] {
  return [
    {
      key: "pool",
      header: "LP pool",
      cell: ({ m, via }) => {
        const a = shownOf(tokens, m.asset, via, n);
        const q = shownOf(tokens, m.quote, via, n);
        return (
          <span className="flex items-center gap-3" data-via={via}>
            <LpIcon asset={{ address: a.address, symbol: a.symbol }} quote={{ address: q.address, symbol: q.symbol }} />
            <span className="min-w-0">
              <span className="block font-medium text-ink" data-testid="lp-pair">
                {a.symbol ?? "…"} / {q.symbol ?? "…"}
              </span>
              <span className="block text-caption text-ink-3">{STYLE_SHORT[m.kind]}</span>
            </span>
          </span>
        );
      },
    },
    {
      key: "price",
      header: "LP price",
      end: true,
      cell: ({ m, seat, via }) => (!seat ? "—" : seat.holder === "0x0000000000000000000000000000000000000000" ? <Pill tone="good">Free to take</Pill> : <span className="num text-ink">{fmtToken(seat.price, shownOf(tokens, m.quote, via, n).token)}</span>),
    },
    {
      key: "holder",
      header: "Holder",
      cell: ({ seat }) => (!seat || seat.holder === "0x0000000000000000000000000000000000000000" ? <span className="text-ink-3">None</span> : isMine(seat, account) ? <span className="font-medium text-brand-ink">You</span> : <span className="mono text-ink-2">{short(seat.holder)}</span>),
    },
    { key: "locked", header: "Locked value", end: true, cell: ({ m, via }) => <LockedCell m={m} tokens={tokens} via={via} n={n} /> },
    { key: "earn", header: "Earns from", wide: true, cell: () => <span className="text-caption text-ink-2">{share} of protocol income, plus interest on your own fills</span> },
    {
      key: "go",
      header: "",
      label: false,
      end: true,
      cell: ({ seat }) => (
        <Button size="sm" variant={isMine(seat, account) ? "secondary" : "primary"} className="max-lg:w-full" tabIndex={-1}>
          {isMine(seat, account) ? "Manage" : "Zap in"}
        </Button>
      ),
    },
  ];
}

/** Quote + collateral the market's pools hold now, the collateral at the display-only reference price. */
function LockedCell({ m, tokens, via, n }: { m: Market; tokens: Tokens; via: Via; n: Names }) {
  const Q = shownOf(tokens, m.quote, via, n).token;
  const A = shownOf(tokens, m.asset, via, n).token;
  const ref = useRefPrice(m.asset, m.quote).data;
  const l = lockedNow(m.pools, refToUnits(ref, Q?.decimals));
  return (
    <span className="num text-ink">
      {l.value !== undefined ? fmtToken(l.value, Q, true, { compact: true }) : <>{fmtToken(l.asset, A, true, { compact: true })}</>}
      {l.value === undefined && l.quote > 0n && <span className="block text-caption text-ink-3">+ {fmtToken(l.quote, Q, true, { compact: true })}</span>}
    </span>
  );
}
