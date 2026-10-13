"use client";

/**
 * One maturity of one market, for people who want the detail (FRONTEND_V3 §8.6; Pendle / Morpho market page): the key
 * facts, past round prices, open offers, your position, and one action per side that leads to the standard Borrow card
 * or Lend drawer. During the repayment window it also takes offers for unrepaid units.
 */
import Link from "next/link";
import { useState } from "react";
import { usePublicClient } from "wagmi";
import { useDemoClientOr } from "@/lib/demo/hooks";
import { useActiveChain } from "@/lib/activeChain";
import { bookOrders, tokenOf, useBatches, useBlockTime, useBook, usePoolSupplies, usePools, useTokens, type BatchRow, type Book, type PoolRow, type Token } from "@/lib/data";
import { usePositions } from "@/lib/position";
import { useActionCtx, useChainClock } from "@/lib/useProduct";
import { useRefPrice } from "@/lib/refPrice";
import { poolDue } from "@/lib/due";
import { netReturn, rateText, refToUnits } from "@/lib/quote";
import { ADVANCE_LABEL, advanceWrite, offerHeld, offerWrites } from "@/lib/proActions";
import { windowLeft } from "@/lib/deadline";
import { fmtChip, fmtClock, fmtExpiry, fmtPer, fmtToken, fmtWait, parseAmount } from "@/lib/format";
import { buyBack, lastTraded, misses, nextRoundAt, poolState, priceGuardBps, roundSeconds, unitScale } from "@/lib/view";
import { positionName, priceSource, type PositionKind } from "@/lib/vocab";
import { sortBest, tokenIdOf, usePositionBook } from "@/lib/secondary";
import { launchTokensOf } from "@/lib/chains";
import { useTx } from "@/lib/tx";
import { AmountInput, Button, Disclosure, Drawer, PositionIcon, Skeleton, Stat, TokenButton, TxErrorLine, useLiveNow } from "../ui";
import { WalletAction } from "../layout/WalletMenu";

export function PoolDrawer({ id, onClose }: { id?: string; onClose: () => void }) {
  const pools = usePools();
  const pool = id ? (pools.data ?? []).find((p) => p.id.toLowerCase() === id.toLowerCase()) : undefined;
  const tokens = useTokens(pool ? [pool.asset, pool.quote] : []).data;
  const A = tokenOf(tokens, pool?.asset);
  const Q = tokenOf(tokens, pool?.quote);
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width={520}
      testId="pool-drawer"
      title={pool && A && Q ? `${A.symbol} / ${Q.symbol}` : "Market"}
      subtitle={pool && Q ? `${pool.kind === 0 ? "Repay any time" : "Repay at maturity"} · matures ${fmtChip(pool.expiry)} UTC · buy-back ${fmtPer(buyBack(pool), Q)} ${Q.symbol}` : undefined}
    >
      {pool && A && Q ? (
        <PoolBody pool={pool} A={A} Q={Q} />
      ) : pools.isLoading ? (
        <div className="grid grid-cols-2 gap-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <p className="text-body-sm text-ink-2">This market is not on this network.</p>
      )}
    </Drawer>
  );
}

function PoolBody({ pool, A, Q }: { pool: PoolRow; A: Token; Q: Token }) {
  const { chainId } = useActiveChain();
  const { now: cn, block } = useChainClock();
  const now = useLiveNow() || cn;
  const ref = useRefPrice(pool.asset, pool.quote).data;
  const refUnits = refToUnits(ref, Q.decimals);
  const book = useBook(pool.id).data;
  const allPools = usePools().data;
  const batches = useBatches(pool.id).data ?? [];
  const pos = usePositions([pool.id]).data?.[pool.id];
  const sup = usePoolSupplies([pool.id]).data?.[pool.id];
  const spb = useBlockTime().data;
  const state = poolState(pool, now, block);
  const f = netReturn(pool, now);
  const lt = launchTokensOf(chainId);
  const offersSell = book ? book.sells.reduce((s, o) => s + o.units, 0n) + book.ncSells.reduce((s, o) => s + o.units, 0n) : undefined;
  const names = { ft: positionName("ft", pool, A, Q, { all: allPools ?? [] }), br: positionName("br", pool, A, Q, { all: allPools ?? [] }) };
  const offersBuy = book ? book.buys.reduce((s, o) => s + (o.units * o.limit) / unitScale(pool), 0n) + book.ncBuys.reduce((s, o) => s + o.escrow, 0n) : undefined;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Fixed rate" value={f.priced ? rateText(f, pool.expiry - now) : "—"} note="net, if repaid" />
        <Stat label="Last traded" value={lastTraded(pool) > 0n ? fmtPer(lastTraded(pool), Q) : "Not yet"} note={refUnits ? `reference ${fmtPer(refUnits, Q)} (${priceSource(chainId, A.address, Q.address, { lst: lt.lst, native: lt.native, assetSymbol: A.symbol })})` : undefined} />
        <Stat label="Matures" value={fmtChip(pool.expiry)} note={pool.expiry > now ? `in ${fmtWait(pool.expiry - now)} (UTC)` : "UTC"} />
        <Stat label="Status" value={state === "open" ? "Open" : stateShort(state)} note={state === "open" ? `next round in ${fmtWait(nextRoundAt(pool, now) - now)}` : stateWord(pool, now, block, spb)} />
        <Stat label="Outstanding" value={sup ? fmtToken(sup.r, A, true, { compact: true }) : "—"} note="collateral sold into this market" />
        <Stat label="Fee" value={`${(pool.feeBps / 100).toLocaleString("en-US")}%`} note="of the interest, only if repaid" />
        <Stat label="Borrower offers" value={offersSell !== undefined ? fmtToken(offersSell, A, true, { compact: true }) : "—"} />
        <Stat label="Lender offers" value={offersBuy !== undefined ? fmtToken(offersBuy, Q, true, { compact: true }) : "—"} />
      </div>

      {state === "open" && (
        <div className="grid grid-cols-2 gap-2">
          <Link href={`/borrow?pool=${pool.id}`} className="btn btn-lg btn-primary">
            Borrow here
          </Link>
          <Link href={`/borrow?pool=${pool.id}&trade=lend`} className="btn btn-lg btn-secondary">
            Lend here
          </Link>
        </div>
      )}

      {pos && (pos.c > 0n || pos.r > 0n) && (
        <section className="text-body-sm">
          <h3 className="mb-2 text-body font-medium">Your position</h3>
          {pos.r > 0n && (
            <p>
              <span className="num">{fmtToken(pos.r, { symbol: names.br.symbol, decimals: A.decimals })}</span>: buy back <span className="num">{fmtToken(pos.r, A)}</span> for{" "}
              <span className="num">{fmtToken((pos.r * buyBack(pool)) / unitScale(pool), Q)}</span>
            </p>
          )}
          {pos.c > 0n && (
            <p>
              <span className="num">{fmtToken(pos.c, { symbol: names.ft.symbol, decimals: A.decimals })}</span>: <span className="num">{fmtToken(pos.c, A)}</span> of collateral backs it
            </p>
          )}
        </section>
      )}

      {state === "window" && <UnclaimedOffer pool={pool} A={A} Q={Q} />}

      <section>
        <h3 className="mb-2 text-body font-medium">Past rounds</h3>
        <PastRounds rows={batches} quote={Q} />
      </section>

      <section>
        <h3 className="mb-2 text-body font-medium">Next round offers</h3>
        <OpenOrders book={book} A={A} Q={Q} />
      </section>

      <section>
        <h3 className="mb-2 text-body font-medium">Holder offers</h3>
        <div className="grid grid-cols-2 gap-4" data-testid="holder-offers">
          <HolderOffers pool={pool} t="ft" A={A} Q={Q} now={now} />
          <HolderOffers pool={pool} t="br" A={A} Q={Q} now={now} />
        </div>
      </section>

      <Disclosure title="Token details">
        <dl className="space-y-3 text-caption" data-testid="token-details">
          {(["ft", "br"] as const).map((t) => (
            <div key={t} className="flex items-start gap-2.5">
              <PositionIcon t={t} asset={A} size={24} />
              <div className="min-w-0">
                <dt className="num font-medium text-ink">{names[t].symbol}</dt>
                <dd className="text-ink-2">
                  {names[t].display} · wallet symbol {names[t].short}
                </dd>
                <dd className="num break-all text-ink-3">Token id {tokenIdText(pool.id, t === "br")}</dd>
              </div>
            </div>
          ))}
        </dl>
      </Disclosure>

      <Disclosure title="Market rules">
        <p className="text-caption text-ink-3">
          Orders are matched every {fmtWait(roundSeconds(pool))} at one price for everyone. Market orders fill only within ±{(priceGuardBps(pool) / 100).toLocaleString("en-US")}% of the last price; after 3 rounds without a fill they
          pause until a new price prints.{misses(pool) > 0 ? ` Rounds without a fill so far: ${misses(pool)}.` : ""}
        </p>
      </Disclosure>
    </div>
  );
}

const stateShort = (s: ReturnType<typeof poolState>) => (s === "paused" ? "Paused" : s === "window" || s === "awaiting" ? "Repaying" : s === "closing" ? "Closing" : s === "closed" ? "Closed" : "Open");

export function stateWord(p: PoolRow, now: number, block: bigint, spb?: number | null): string {
  const s = poolState(p, now, block);
  if (s === "open") return `Open · next round in ${fmtWait(nextRoundAt(p, now) - now)}`;
  if (s === "paused") {
    const until = spb ? now + Number(p.pausedUntil - block) * spb : 0;
    return until > now ? `Paused by the guardian until ≈ ${fmtClock(Math.round(until))}; repaying and withdrawing still work` : "Paused by the guardian";
  }
  if (s === "awaiting") return "Matured · repayment opens shortly";
  if (s === "window") {
    const left = windowLeft(p, block, spb);
    return left > 0 ? `Matured · borrowers repaying, ≈ ${fmtWait(left)} left` : "Matured · borrowers repaying";
  }
  if (s === "closing") return "Closing";
  return "Closed";
}

/** Last 12 round prices as one line (inline SVG, no grid, min and max labelled). */
export function PastRounds({ rows, quote }: { rows: BatchRow[]; quote: Token }) {
  const pts = rows.filter((r) => r.price > 0n).slice(0, 12).reverse();
  if (pts.length === 0) return <p className="text-body-sm text-ink-3">No round has traded yet.</p>;
  if (pts.length < 3)
    return (
      <p className="tabular-nums text-body-sm text-ink-2">
        {pts.length} round{pts.length > 1 ? "s" : ""} traded so far, latest at {fmtPer(pts[pts.length - 1]!.price, quote)} {quote.symbol}.
      </p>
    );
  const vals = pts.map((r) => Number(r.price));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const W = 460;
  const H = 120;
  const pad = 8;
  const x = (i: number) => (pts.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (pts.length - 1));
  const y = (v: number) => (hi === lo ? H / 2 : H - pad - ((v - lo) * (H - 2 * pad)) / (hi - lo));
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <figure className="well px-3 py-3" aria-label={`Price of the last ${pts.length} rounds, from ${fmtPer(pts[0]!.price, quote)} to ${fmtPer(pts[pts.length - 1]!.price, quote)}`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[120px] w-full" preserveAspectRatio="none" aria-hidden>
        <path d={d} fill="none" stroke="var(--chart-line)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {vals.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={i === vals.length - 1 ? 3.5 : 0} fill="var(--chart-line)" />
        ))}
      </svg>
      <figcaption className="num mt-1 flex justify-between text-label text-ink-3">
        <span>Low {fmtPer(BigInt(lo), quote)}</span>
        <span>Latest {fmtPer(pts[pts.length - 1]!.price, quote)}</span>
        <span>High {fmtPer(BigInt(hi), quote)}</span>
      </figcaption>
    </figure>
  );
}

function OpenOrders({ book, A, Q }: { book?: Book; A: Token; Q: Token }) {
  if (!book) return <Skeleton className="h-16 w-full" />;
  if (!book.sells.length && !book.buys.length && !book.ncSells.length && !book.ncBuys.length) return <p className="text-body-sm text-ink-3">No open offers.</p>;
  const sells = [...book.sells].sort((a, b) => (a.limit < b.limit ? -1 : 1)).slice(0, 8);
  const buys = [...book.buys].sort((a, b) => (a.limit > b.limit ? -1 : 1)).slice(0, 8);
  const ncS = book.ncSells.reduce((s, o) => s + o.units, 0n);
  const ncB = book.ncBuys.reduce((s, o) => s + o.escrow, 0n);
  const Col = ({ title, rows, at }: { title: string; rows: typeof sells; at?: string }) => (
    <div className="min-w-0">
      <p className="mb-1 text-caption text-ink-3">{title}</p>
      <ul className="num space-y-1 text-caption">
        {at && <li className="text-ink-2">{at}</li>}
        {rows.map((o) => (
          <li key={String(o.id)} className="flex justify-between gap-2">
            <span>{fmtPer(o.limit, Q)}</span>
            <span className="text-ink-2">× {fmtToken(o.units, A, false)}</span>
          </li>
        ))}
        {rows.length === 0 && !at && <li className="text-ink-3">None</li>}
      </ul>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-4">
      <Col title="Borrowers (selling collateral)" rows={sells} at={book.ncSells.length ? `Market orders: ${book.ncSells.length} order${book.ncSells.length > 1 ? "s" : ""}, ${fmtToken(ncS, A)}` : undefined} />
      <Col title="Lenders (lending)" rows={buys} at={book.ncBuys.length ? `Market orders: ${book.ncBuys.length} order${book.ncBuys.length > 1 ? "s" : ""}, ${fmtToken(ncB, Q)}` : undefined} />
    </div>
  );
}

/** The ERC-6909 id as a decimal string (pro view only). */
const tokenIdText = (id: `0x${string}`, isR: boolean) => {
  try {
    return tokenIdOf(id, isR).toString();
  } catch {
    return "—";
  }
};

/** C or R offers from holders in the position market: listings (cheapest first) and bids (highest first). */
function HolderOffers({ pool, t, A, Q, now }: { pool: PoolRow; t: PositionKind; A: Token; Q: Token; now: number }) {
  const book = usePositionBook(pool, t === "br", 5);
  const asks = sortBest(book.asks, now).slice(0, 5);
  const bids = sortBest(book.bids, now).slice(0, 5);
  const prefix = t === "ft" ? "C" : "R";
  return (
    <div className="min-w-0">
      <p className="mb-1 text-caption text-ink-3">{prefix} offers</p>
      {!book.market ? (
        <p className="text-caption text-ink-3">No holder market on this network</p>
      ) : asks.length + bids.length === 0 ? (
        <p className="text-caption text-ink-3">None</p>
      ) : (
        <ul className="num space-y-1 text-caption">
          {asks.map((o) => (
            <li key={`a${o.id}`} className="flex justify-between gap-2">
              <span>Selling at {fmtPer(o.price, Q)}</span>
              <span className="text-ink-2">× {fmtToken(o.units, A, false)}</span>
            </li>
          ))}
          {bids.map((o) => (
            <li key={`b${o.id}`} className="flex justify-between gap-2">
              <span>Buying at {fmtPer(o.price, Q)}</span>
              <span className="text-ink-2">× {fmtToken(o.units, A, false)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UnclaimedOffer({ pool, A, Q }: { pool: PoolRow; A: Token; Q: Token }) {
  const supplies = usePoolSupplies([pool.id]).data;
  const unclaimed = supplies?.[pool.id]?.r;
  const [units, setUnits] = useState("");
  const [extra, setExtra] = useState("");
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const appChain = useActiveChain().chainId;
  const client = useDemoClientOr(usePublicClient({ chainId: appChain }), appChain);
  const u = parseAmount(units, A.decimals);
  const e = parseAmount(extra, Q.decimals);
  return (
    <section className="space-y-3">
      <h3 className="text-body font-medium">Offer for unrepaid collateral</h3>
      <p className="text-body-sm text-ink-2">
        Not yet repaid: <span className="num">{unclaimed !== undefined ? fmtToken(unclaimed, A) : "—"}</span>. Whatever is still unrepaid when the window closes goes to the highest offers: lenders are paid the buy-back price and the
        premium goes to the original borrower. A borrower who repays in time always comes first.
      </p>
      <AmountInput big={false} label={`Amount (${A.symbol})`} value={units} onChange={setUnits} decimals={A.decimals} token={<TokenButton symbol={A.symbol} address={A.address} />} />
      <AmountInput big={false} label="Premium per unit, paid to the original borrower" value={extra} onChange={setExtra} decimals={Q.decimals} token={<TokenButton symbol={Q.symbol} address={Q.address} />} />
      <p className="tabular-nums text-caption text-ink-3">Held while waiting: {fmtToken(offerHeld(pool, u, e), Q)}</p>
      <TxErrorLine error={tx.lastError} />
      <WalletAction size="md">
        <Button variant="secondary" size="md" block disabled={u === 0n || tx.busy || !ctx || !client} loading={tx.busy} onClick={() => ctx && client && void tx.run(() => offerWrites({ client: client as never, core: ctx.core, ensureAllowance: tx.ensureAllowance }, pool, u, e, Q))}>
          Offer
        </Button>
      </WalletAction>
    </section>
  );
}

/** The buttons that move a market forward; anyone may press them (the keeper normally does). */
export function AdvanceMarket({ pool, book, now, block }: { pool: PoolRow; book?: Book; now: number; block: bigint }) {
  const { deployment } = useActiveChain();
  const tx = useTx();
  const { action, dead } = poolDue(pool, now, block, book ? bookOrders(book) : undefined);
  const w = deployment ? advanceWrite(deployment.confluere, pool, action, dead) : undefined;
  const spb = useBlockTime().data;
  return (
    <div className="space-y-2 text-body-sm">
      <p className="text-ink-2">Anyone can run this; it costs only gas. The keeper usually does it within a minute.</p>
      {w ? (
        <Button size="sm" variant="secondary" loading={tx.busy} disabled={!tx.account} onClick={() => void tx.run([w])}>
          {ADVANCE_LABEL[action]}
        </Button>
      ) : (
        <p className="text-ink-3">Nothing to do right now. {stateWord(pool, now, block, spb)}.</p>
      )}
      <TxErrorLine error={tx.lastError} />
    </div>
  );
}

