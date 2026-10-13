"use client";

/**
 * The market list (IA v3.1 items 2 and 3; Pendle's PT / YT list): one row per pool, i.e. per maturity and buy-back
 * price, with its two position tokens side by side. C, the lender token, trades at the round price and earns the
 * gap to the buy-back price if repaid; R, the buy-back right, is priced by the cheapest holder offer and pays off above
 * buy-back price + its cost. Each token cell is its own button that opens the drawer on that token; the rest of the row
 * opens it on the page's default. Size is the collateral not yet bought back.
 */
import type { Address } from "viem";
import { tokenOf, type PoolRow, type Token } from "@/lib/data";
import { netReturn } from "@/lib/quote";
import { fmtChip, fmtPer, fmtToken, fmtWait } from "@/lib/format";
import type { BestOffers } from "@/lib/secondary";
import { useDemo } from "@/lib/demo/mode";
import { sellPrice } from "@/lib/demo/sell";
import { useRefPrice } from "@/lib/refPrice";
import { buyBack, lastTraded, poolState } from "@/lib/view";
import { breakEven, POSITION, type PositionKind } from "@/lib/vocab";
import { shownToken, twinKey, type Via } from "@/lib/twins";
import { useTwinCtx } from "@/lib/native";
import { List, Pill, TokenIcon, stop, type Column } from "../ui";
import { fixedWords } from "./positionBits";

export type Tokens = Record<string, Token> | undefined;
/** `via` / `twin`: the row's pairing (lib/twins), so the drawer opens with Pay with preset to it. */
export type OpenMarket = (id: string, token?: PositionKind, via?: Via, twin?: boolean) => void;
/** A list row: the pool, with its pairing when the list twins it (HYPE / USDC next to WHYPE / USDC). */
export type MarketRow = PoolRow & { via?: Via; twin?: boolean };
type Names = { wrapped: string | undefined; coin: string };

export const MARKET_TEMPLATE = "minmax(220px,1.4fr) minmax(130px,1fr) minmax(100px,0.8fr) minmax(150px,1.1fr) minmax(150px,1.1fr) minmax(100px,0.7fr)";

const cellBtn = "-mx-2 -my-1.5 block rounded-[var(--radius-control)] px-2 py-1.5 text-right transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 lg:ml-auto";

/** "HYPE / USDC" on a native row, "WHYPE / USDC" on the on-chain one. */
export const rowPair = (tokens: Tokens, p: MarketRow, n: Names) => {
  const a = shownToken(tokenOf(tokens, p.asset), p.asset, p.via, n.wrapped, n.coin);
  const q = shownToken(tokenOf(tokens, p.quote), p.quote, p.via, n.wrapped, n.coin);
  return { a, q, name: `${a.symbol ?? "…"} / ${q.symbol ?? "…"}` };
};

export function marketColumns({ tokens, now, block, supplies, offers, onOpen, names = { wrapped: undefined, coin: "" } }: { tokens: Tokens; now: number; block: bigint; supplies?: Record<string, { c: bigint; r: bigint }>; offers?: Record<string, BestOffers>; onOpen?: OpenMarket; names?: Names }): Column<MarketRow>[] {
  /** The token with the row's name for it (HYPE on a native row; decimals and address as on chain). */
  const tok = (p: MarketRow, a: string): Token | undefined => {
    const t = tokenOf(tokens, a);
    const s = shownToken(t, a, p.via, names.wrapped, names.coin);
    return t && s.native ? { ...t, symbol: s.symbol ?? t.symbol } : t;
  };
  const tokenCell = (p: MarketRow, t: PositionKind, top: React.ReactNode, sub: React.ReactNode) => {
    const body = (
      <>
        <span className="block text-body font-semibold text-ink">{top}</span>
        <span className="block text-caption text-ink-3">{sub}</span>
      </>
    );
    return onOpen ? (
      <button type="button" className={`num ${cellBtn}`} onClick={stop(() => onOpen(p.id, t, p.via, p.twin))} data-testid={`market-${t}`} aria-label={`${POSITION[t].display}, ${rowPair(tokens, p, names).name}`}>
        {body}
      </button>
    ) : (
      <span className="num block text-right">{body}</span>
    );
  };
  return [
    {
      key: "mkt",
      header: "Market",
      cell: (p) => {
        const { a, q, name } = rowPair(tokens, p, names);
        return (
          <span className="flex items-center gap-2.5" data-via={p.via}>
            <span className="flex flex-none -space-x-2">
              <TokenIcon symbol={a.symbol} address={a.address as Address} size={28} />
              <TokenIcon symbol={q.symbol} address={q.address as Address} size={28} />
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-ink" data-testid="market-pair">
                {name}
              </span>
              <span className="block text-caption text-ink-3">{p.kind === 0 ? "Repay any time" : "Repay at maturity"}</span>
            </span>
            {!p.graduated && poolState(p, now, block) !== "closed" && <Pill title="Opened recently; vaults don't lend here yet.">New</Pill>}
          </span>
        );
      },
    },
    {
      key: "mat",
      header: "Maturity (UTC)",
      cell: (p) => (
        <span className="num">
          <span className="block text-ink">{fmtChip(p.expiry)}</span>
          <span className="block text-caption text-ink-3">{p.expiry > now ? `in ${fmtWait(p.expiry - now)}` : stateText(p, now, block)}</span>
        </span>
      ),
    },
    { key: "bb", header: "Buy-back price", end: true, cell: (p) => <span className="num text-ink">{fmtPer(buyBack(p), tok(p, p.quote))}</span> },
    {
      key: "ft",
      header: POSITION.ft.tab,
      end: true,
      cell: (p) => {
        const q = tok(p, p.quote);
        const f = netReturn(p, now);
        return lastTraded(p) > 0n
          ? tokenCell(p, "ft", `${fmtPer(lastTraded(p), q)} ${q?.symbol ?? ""}`, p.expiry > now ? `${fixedWords(f)} if repaid` : "Matured")
          : tokenCell(p, "ft", <span className="font-normal text-ink-3">No trades yet</span>, "—");
      },
    },
    {
      key: "br",
      header: POSITION.br.tab,
      end: true,
      cell: (p) => {
        const q = tok(p, p.quote);
        const ask = offers?.[p.id.toLowerCase()]?.brAsk;
        if (ask) return tokenCell(p, "br", `${fmtPer(ask, q)} ${q?.symbol ?? ""}`, `break-even ${fmtPer(breakEven(buyBack(p), ask), q)}`);
        // the demo network has no holder market: its estimated price, as the drawer shows it
        return tokenCell(p, "br", <DemoBrPrice pool={p} quote={q} />, <DemoBrNote pool={p} quote={q} />);
      },
    },
    {
      key: "size",
      header: "Size",
      end: true,
      cell: (p) => <span className="num text-ink-2">{supplies?.[p.id] ? fmtToken(supplies[p.id]!.r, tok(p, p.asset), true, { compact: true }) : "—"}</span>,
    },
  ];
}

/** R cell without a holder offer: "No offers yet", or in the demo the sample network's estimated price. */
function useDemoBr(pool: PoolRow, quote: Token | undefined): bigint | undefined {
  const demo = useDemo();
  const ref = useRefPrice(demo ? pool.asset : undefined, demo ? pool.quote : undefined).data;
  if (!demo || !quote) return undefined;
  const p = sellPrice("r", pool.lastClearingPrice, ref, quote.decimals);
  return p > 0n ? p : undefined;
}

function DemoBrPrice({ pool, quote }: { pool: PoolRow; quote: Token | undefined }) {
  const est = useDemoBr(pool, quote);
  return est ? <>≈ {fmtPer(est, quote)} {quote?.symbol}</> : <span className="font-normal text-ink-3">No offers yet</span>;
}

function DemoBrNote({ pool, quote }: { pool: PoolRow; quote: Token | undefined }) {
  const est = useDemoBr(pool, quote);
  return <>{est ? `break-even ${fmtPer(breakEven(buyBack(pool), est), quote)}` : `buys back at ${fmtPer(buyBack(pool), quote)}`}</>;
}

export function stateText(p: PoolRow, now: number, block: bigint): string {
  const s = poolState(p, now, block);
  if (s === "open") return "Open";
  if (s === "paused") return "Paused";
  if (s === "window" || s === "awaiting") return "Matured, repaying";
  if (s === "closing") return "Closing";
  return "Closed";
}

export function TokenMarketList({ rows, tokens, now, block, supplies, offers, onOpen, loading, error, testId = "token-markets" }: { rows: MarketRow[]; tokens: Tokens; now: number; block: bigint; supplies?: Record<string, { c: bigint; r: bigint }>; offers?: Record<string, BestOffers>; onOpen: OpenMarket; loading?: boolean; error?: React.ReactNode; testId?: string }) {
  const names = useTwinCtx();
  return (
    <List
      testId={testId}
      columns={marketColumns({ tokens, now, block, supplies, offers, onOpen, names })}
      template={MARKET_TEMPLATE}
      rows={rows}
      loading={loading}
      error={error}
      rowKey={(p) => twinKey(p.id, p.via)}
      onRow={(p) => onOpen(p.id, undefined, p.via, p.twin)}
      rowLabel={(p) => `${rowPair(tokens, p, names).name}, matures ${fmtChip(p.expiry)}`}
    />
  );
}
