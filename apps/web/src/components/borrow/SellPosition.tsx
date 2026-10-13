"use client";

/**
 * Buy and sell C (lender token) and R (buy-back right) from other holders before maturity, through the position
 * market (lib/secondary). The trade card's Buy and Sell tabs render `PositionBuy` and `PositionSell`. Sell: instantly
 * into the best bids, or list at your own price (an C price is also shown as the buyer's fixed APR, Pendle's limit
 * order style). Buy: take the cheapest listings. Your open offers are listed with a cancel button; cancels work in any
 * pool state, so escrow always comes back.
 */
import { useState } from "react";
import { useConnection } from "wagmi";
import type { PoolRow, Token } from "@/lib/data";
import { fmtPer, fmtToken, parseAmount, toInput } from "@/lib/format";
import { usePositions } from "@/lib/position";
import { netReturn } from "@/lib/quote";
import { useTx } from "@/lib/tx";
import { useDemo } from "@/lib/demo/mode";
import { useChainClock } from "@/lib/useProduct";
import { buyBack, unitScale } from "@/lib/view";
import { breakEven, type PositionKind, type PositionName } from "@/lib/vocab";
import {
  bidWrites,
  buyNowWrites,
  cancelWrite,
  costOf,
  listWrites,
  offerExpiry,
  planTakes,
  sellNowWrites,
  sortBest,
  tradable,
  usePositionBook,
  useSecondaryCtx,
  type MarketOffer,
} from "@/lib/secondary";
import { AmountInput, Button, ChipRow, DetailRows, PositionIcon, Segmented, StepsLine, TokenButton, TxErrorLine, stageLabel } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { fixedWords, usePositionNames, useRepayBy } from "./positionBits";

type Props = { pool: PoolRow; A: Token; Q: Token; token: PositionKind };
type Book = ReturnType<typeof usePositionBook>;

const LASTS = [
  { value: 24, label: "1 day" },
  { value: 168, label: "7 days" },
  { value: 0, label: "Until it stops trading" },
];

/** The position token in an amount field: collateral logo with its C / R badge and the short symbol. */
export function PositionButton({ t, A, name }: { t: PositionKind; A: Token; name: PositionName }) {
  return (
    <span className="inline-flex h-10 flex-none items-center gap-2 rounded-full bg-surface px-3 shadow-whisper" title={`${name.symbol}, ${name.display}`} data-testid="position-button">
      <PositionIcon t={t} asset={A} size={24} />
      <span className="text-body font-medium">{name.short}</span>
    </span>
  );
}

/** Market not here, or the token can no longer trade: one explanation instead of a form. */
function useGate({ pool, token }: Pick<Props, "pool" | "token">) {
  const demo = useDemo();
  const isR = token === "br";
  const book = usePositionBook(pool, isR);
  const { now, block } = useChainClock();
  const live = now === 0 || tradable(pool, isR, now, block);
  let gate: React.ReactNode = null;
  if (demo || !book.market)
    gate = (
      <div className="well px-4 py-3" data-testid="sell-unavailable">
        <p className="text-body-sm font-medium text-ink">Position market not available here</p>
        <p className="mt-1 text-caption text-ink-2">
          {demo ? "The demo network has no position market." : "The position market isn't deployed on this network yet."} Until then,{" "}
          {isR ? "repay at any time the market allows, or let the loan close" : `hold your C to maturity and collect the payout in Portfolio`}.
        </p>
      </div>
    );
  else if (!live)
    gate = (
      <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-body-sm text-ink-2" data-testid="pm-closed">
        {isR ? "This R expired when the repayment window ended." : "This C has matured. Collect your payout in Portfolio."}
      </p>
    );
  return { gate, book, now, isR };
}

export function PositionSell(props: Props) {
  const { gate, book, now, isR } = useGate(props);
  const names = usePositionNames(props.pool, props.A, props.Q);
  if (gate && !book.mine.length) return gate;
  return (
    <div className="space-y-4" data-testid="sell-position">
      {gate ?? <SellForm key={`sell-${props.pool.id}-${props.token}`} {...props} isR={isR} book={book} now={now} name={names[props.token]} />}
      {book.market && <MyOffers offers={book.mine} market={book.market} A={props.A} name={names[props.token]} Q={props.Q} onDone={() => void book.refetch()} />}
    </div>
  );
}

export function PositionBuy(props: Props) {
  const { gate, book, now, isR } = useGate(props);
  const names = usePositionNames(props.pool, props.A, props.Q);
  if (gate) return gate;
  return (
    <div className="space-y-4" data-testid="buy-position">
      <BuyForm key={`buy-${props.pool.id}-${props.token}`} {...props} isR={isR} book={book} now={now} name={names[props.token]} />
      {book.market && <MyOffers offers={book.mine} market={book.market} A={props.A} name={names[props.token]} Q={props.Q} onDone={() => void book.refetch()} />}
    </div>
  );
}

function SellForm({ pool, A, Q, token, isR, book, now, name }: Props & { isR: boolean; book: Book; now: number; name: PositionName }) {
  const { address } = useConnection();
  const tx = useTx();
  const ctx = useSecondaryCtx(tx);
  const pos = usePositions([pool.id]).data?.[pool.id];
  const [how, setHow] = useState<"now" | "list">("now");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [lasts, setLasts] = useState(168);
  const P = name.prefix;
  const units = parseAmount(amount, A.decimals);
  const locked = isR && pos ? pos.locked : 0n;
  const held = !pos ? 0n : isR ? (pos.r > pos.locked ? pos.r - pos.locked : 0n) : pos.c;
  const bids = sortBest(book.bids, now);
  const plan = planTakes(bids, units, A.decimals, { skip: address });
  const per = parseAmount(price, Q.decimals);
  const listed = costOf(units, per, A.decimals);
  const unit = { symbol: P, decimals: A.decimals };
  const full = { symbol: name.symbol, decimals: A.decimals };
  const bb = buyBack(pool);
  const bestBid = bids[0]?.price;

  let label = how === "now" ? `Sell ${P} now` : `List ${P}`;
  let can = false;
  if (units === 0n) label = "Enter an amount";
  else if (units > held) label = `Not enough ${P}`;
  else if (how === "now" && plan.units === 0n) label = "No offers yet: set your price";
  else if (how === "list" && per === 0n) label = "Enter your price";
  else can = true;

  const go = () =>
    ctx &&
    void tx.run(
      () => (how === "now" ? sellNowWrites(ctx, { takes: plan.takes, T: P }) : listWrites(ctx, { poolId: pool.id, isR, units, price: per, expiresAt: offerExpiry(now, lasts), T: P })),
      {
        successMessage: how === "now" ? `Sold ${fmtToken(plan.units, full)} for ${fmtToken(plan.quote, Q)}.` : `Listed ${fmtToken(units, full)} at ${fmtPer(per, Q)} ${Q.symbol} each.`,
        onSuccess: () => {
          setAmount("");
          void book.refetch();
        },
      },
    );

  const listHint = per > 0n ? (isR ? `Break-even for the buyer: ${A.symbol} above ${fmtPer(breakEven(bb, per), Q)}` : per < bb ? `= ${fixedWords(netReturn(pool, now, per))} for the buyer` : "At or above the buy-back price: no return for the buyer") : bestBid ? `Best offer ${fmtPer(bestBid, Q)}` : "No offers yet";

  return (
    <div className="space-y-4" data-testid="pm-sell">
      <Segmented
        label="How"
        value={how}
        onChange={(v) => {
          setHow(v);
          tx.reset();
        }}
        className="w-full [&>button]:flex-1"
        options={[
          { value: "now", label: "Sell now", testId: "pm-sell-now" },
          { value: "list", label: "Set your price", testId: "pm-sell-list" },
        ]}
      />
      <AmountInput
        label="You sell"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        decimals={A.decimals}
        testId="pm-sell-input"
        token={<PositionButton t={token} A={A} name={name} />}
        helper={<span>{isR ? `1 ${P} buys back 1 ${A.symbol}` : `1 ${P} = 1 ${A.symbol} of backing`}</span>}
        balance={address ? <span className="num">You hold {fmtToken(held, unit)}{locked > 0n ? ` (${fmtToken(locked, { decimals: A.decimals })} locked in an extension)` : ""}</span> : undefined}
        onMax={address && held > 0n ? () => setAmount(toInput(held, A.decimals)) : undefined}
      />
      {how === "list" && (
        <>
          <AmountInput
            label={`Your price per ${P}`}
            value={price}
            onChange={(v) => {
              setPrice(v);
              tx.reset();
            }}
            readOnly={tx.busy}
            decimals={Q.decimals}
            big={false}
            testId="pm-sell-price"
            token={<TokenButton symbol={Q.symbol} address={Q.address} />}
            helper={<span className="num" data-testid="pm-sell-price-hint">{listHint}</span>}
          />
          <ChipRow label="Offer lasts" value={lasts} onChange={setLasts} options={LASTS} />
        </>
      )}
      <DetailRows
        rows={
          how === "now"
            ? [
                { k: "Best offer", v: bestBid ? `${fmtPer(bestBid, Q)} ${Q.symbol} per ${P}` : "No offers yet" },
                { k: "You receive", v: plan.quote > 0n ? fmtToken(plan.quote, Q) : "—", testId: "pm-sell-receive" },
                !isR && bestBid !== undefined && bestBid < bb && { k: "Buyer's fixed rate", v: fixedWords(netReturn(pool, now, bestBid)) },
                plan.short > 0n && units > 0n && { k: "Not filled", v: <span className="whitespace-normal">{`${fmtToken(plan.short, unit)}: set your price for the rest`}</span>, tone: "warn" },
                { k: "After the sale", v: <span className="whitespace-normal">{isR ? `You can no longer buy this ${A.symbol} back. The buyer can.` : "You no longer receive the payout at maturity"}</span> },
                isR && held > 0n && { k: "Your loan", v: <span className="whitespace-normal">{`If this is your loan's buy-back right, selling it means you won't get your ${A.symbol} back.`}</span>, tone: "warn" },
              ]
            : [
                { k: "If all of it sells", v: listed > 0n ? `you receive ${fmtToken(listed, Q)}` : "—", testId: "pm-list-receive" },
                { k: "Until then", v: <span className="whitespace-normal">{`Your ${P} waits in the market; cancel any time to get it back`}</span> },
              ]
        }
      />
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button variant="primary" size="lg" block disabled={!can || !ctx || tx.busy} loading={tx.busy} onClick={go} data-testid="pm-sell-button">
          {stageLabel(tx.steps, label)}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} />
    </div>
  );
}

function BuyForm({ pool, A, Q, token, isR, book, now, name }: Props & { isR: boolean; book: Book; now: number; name: PositionName }) {
  const { address } = useConnection();
  const tx = useTx();
  const ctx = useSecondaryCtx(tx);
  const until = useRepayBy(pool);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [lasts, setLasts] = useState(168);
  const P = name.prefix;
  const unit = { symbol: P, decimals: A.decimals };
  const full = { symbol: name.symbol, decimals: A.decimals };
  const units = parseAmount(amount, A.decimals);
  const asks = sortBest(book.asks, now).filter((o) => !address || o.maker.toLowerCase() !== address.toLowerCase());
  // Buy is always available: instant from listings when there are any, otherwise a bid at your
  // price that sellers can fill
  const [howSt, setHow] = useState<"now" | "bid">();
  const how = howSt ?? (asks.length > 0 ? "now" : "bid");
  const plan = planTakes(asks, units, A.decimals);
  const available = asks.slice(0, 3).reduce((s, o) => s + o.units, 0n);
  const bb = buyBack(pool);
  const per = parseAmount(price, Q.decimals);
  const bidCost = costOf(units, per, A.decimals);
  const avg = how === "bid" ? (per > 0n ? per : undefined) : plan.units > 0n ? plan.avg : asks[0]?.price;
  const f = avg ? netReturn(pool, now, avg) : undefined;
  const n = how === "bid" ? units : plan.units > 0n ? plan.units : 0n;

  let label = how === "now" ? `Buy ${P} now` : `Place bid for ${P}`;
  let can = false;
  if (units === 0n) label = "Enter an amount";
  else if (how === "now" && asks.length === 0) label = "No listings yet: set your price";
  else if (how === "bid" && per === 0n) label = "Enter your price";
  else can = true;

  const go = () =>
    ctx &&
    void tx.run(
      () => (how === "now" ? buyNowWrites(ctx, { takes: plan.takes, quote: Q, T: P }) : bidWrites(ctx, { poolId: pool.id, isR, units, price: per, expiresAt: offerExpiry(now, lasts), quote: Q, assetDecimals: A.decimals, T: P })),
      {
        successMessage: how === "now" ? `Bought ${fmtToken(plan.units, full)} for ${fmtToken(plan.quote, Q)}.` : `Bid placed for ${fmtToken(units, full)} at ${fmtPer(per, Q)} ${Q.symbol} each.`,
        onSuccess: () => {
          setAmount("");
          void book.refetch();
        },
      },
    );

  return (
    <div className="space-y-4" data-testid="pm-buy">
      <Segmented
        label="How"
        value={how}
        onChange={(v) => {
          setHow(v);
          tx.reset();
        }}
        className="w-full [&>button]:flex-1"
        options={[
          { value: "now", label: "Buy now", testId: "pm-buy-now" },
          { value: "bid", label: "Set your price", testId: "pm-buy-bid" },
        ]}
      />
      <AmountInput
        label="You receive"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        decimals={A.decimals}
        testId="pm-buy-input"
        token={<PositionButton t={token} A={A} name={name} />}
        balance={how === "now" && asks.length > 0 ? <span className="num">Listed {fmtToken(available, unit)}</span> : undefined}
        onMax={how === "now" && available > 0n ? () => setAmount(toInput(available, A.decimals)) : undefined}
      />
      {how === "bid" && (
        <>
          <AmountInput
            label={`Your price per ${P}`}
            value={price}
            onChange={(v) => {
              setPrice(v);
              tx.reset();
            }}
            readOnly={tx.busy}
            decimals={Q.decimals}
            big={false}
            testId="pm-buy-price"
            token={<TokenButton symbol={Q.symbol} address={Q.address} />}
            helper={<span className="num">{asks[0] ? `Cheapest listing ${fmtPer(asks[0].price, Q)}` : isR ? `Buys back at ${fmtPer(bb, Q)}` : per > 0n && per < bb ? `= ${fixedWords(netReturn(pool, now, per))} if repaid` : `Pays up to ${fmtPer(bb, Q)} at maturity`}</span>}
          />
          <ChipRow label="Bid lasts" value={lasts} onChange={setLasts} options={LASTS} />
        </>
      )}
      <DetailRows
        rows={[
          how === "now" && { k: plan.units > 0n ? "Average price" : "Cheapest listing", v: avg ? `${fmtPer(avg, Q)} ${Q.symbol} per ${P}` : "None yet" },
          { k: how === "bid" ? "You set aside" : "You pay", v: how === "bid" ? (bidCost > 0n ? fmtToken(bidCost, Q) : "—") : plan.quote > 0n ? fmtToken(plan.quote, Q) : "—", testId: "pm-buy-pay" },
          ...(isR
            ? [
                { k: "Lets you", v: <span className="whitespace-normal">{`Buy ${n > 0n ? fmtToken(n, A) : `1 ${A.symbol}`} for ${fmtPer(bb, Q)} ${Q.symbol} each until ${until.text}`}</span> },
                avg ? { k: "Break-even", v: `${A.symbol} above ${fmtPer(breakEven(bb, avg), Q)}` } : null,
                { k: "Worth nothing", v: <span className="whitespace-normal">{`after ${until.text}`}</span> },
              ]
            : [
                f && avg && avg < bb ? { k: "Fixed rate at this price", v: `${fixedWords(f)}, if repaid` } : null,
                { k: "At maturity", v: <span className="whitespace-normal">{`${n > 0n ? fmtToken((n * (f?.netPerUnit || bb)) / unitScale(pool), Q) : `${fmtPer(f?.netPerUnit || bb, Q)} ${Q.symbol}`} if the borrower buys back, otherwise ${n > 0n ? fmtToken(n, A) : `1 ${A.symbol}`}`}</span> },
              ]),
          { k: "Fills", v: how === "now" ? "Instant, at listed prices" : <span className="whitespace-normal">When a holder sells to you; cancel any time to get your {Q.symbol} back</span> },
          how === "now" && plan.short > 0n && units > 0n && { k: "Not available", v: fmtToken(plan.short, unit), tone: "warn" },
        ]}
      />
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button variant="primary" size="lg" block disabled={!can || !ctx || tx.busy} loading={tx.busy} onClick={go} data-testid="pm-buy-button">
          {stageLabel(tx.steps, label)}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} />
    </div>
  );
}

function MyOffers({ offers, market, A, Q, name, onDone }: { offers: MarketOffer[]; market: `0x${string}`; A: Token; Q: Token; name: PositionName; onDone: () => void }) {
  const tx = useTx();
  const [busyId, setBusyId] = useState<bigint>();
  if (offers.length === 0) return null;
  const unit = { symbol: name.prefix, decimals: A.decimals };
  return (
    <div className="space-y-2" data-testid="pm-mine">
      <p className="text-caption text-ink-2">Your open offers</p>
      <ul className="space-y-1.5">
        {offers.map((o) => (
          <li key={o.id.toString()} className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-body-sm">
            <span className="num">
              {o.isBid ? "Buying" : "Selling"} {fmtToken(o.units, unit)} at {fmtPer(o.price, Q)}
            </span>
            <Button
              variant="quiet"
              size="sm"
              disabled={tx.busy}
              loading={tx.busy && busyId === o.id}
              onClick={() => {
                setBusyId(o.id);
                void tx.run([cancelWrite(market, o)], { successMessage: o.isBid ? "Offer cancelled. Your funds are back in your wallet." : `Listing cancelled. Your ${name.prefix} is back.`, onSuccess: onDone });
              }}
              data-testid={`pm-cancel-${o.id}`}
            >
              Cancel
            </Button>
          </li>
        ))}
      </ul>
      <TxErrorLine error={tx.lastError} />
    </div>
  );
}
