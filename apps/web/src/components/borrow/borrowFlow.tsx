"use client";

/**
 * One borrow order into one pool, shared by the home card (the router picks the pool) and the trade card of a market
 * (the pool is fixed). The borrower sells collateral now at the round's price and receives the quote token plus the
 * right to buy the collateral back at the pool's buy-back price before the repayment deadline.
 *
 * `useBorrowOrder` holds the order state (amount, price mode, worst accepted price, rounds, the watch after submitting) and the
 * button state machine; `BorrowSettings`, `BorrowReview` and `BorrowStatus` render the parts both cards share.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useConnection } from "wagmi";
import { quoteDown, scaleOf } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { launchTokensOf } from "@/lib/chains";
import { useAccountOrders, useBlockTime, useMinNotional, type PoolRow, type Token } from "@/lib/data";
import { useBalances, usePending, usePositions } from "@/lib/position";
import { useActionCtx, useChainClock } from "@/lib/useProduct";
import { borrowQuote, defaultBorrowLimit, defaultMoveBps, minUnits, netAtPrice, refToUnits, type BorrowQuote } from "@/lib/quote";
import { repayDeadline, type Deadline } from "@/lib/deadline";
import { borrowWrites } from "@/lib/actions";
import { defaultTtl } from "@/lib/order";
import { useAllowance } from "@/lib/allowance";
import { useOrderWatch, type WatchStart, type WatchState } from "@/lib/orderStatus";
import { fmtClock, fmtPer, fmtToken, fmtWait, parseAmount, pct, toInput } from "@/lib/format";
import { buyBack, lastTraded, repaysAnyTime, roundSeconds } from "@/lib/view";
import { priceSource } from "@/lib/vocab";
import { useTx } from "@/lib/tx";
import { isWrappedNative, nativeTokenOf, spendableNative, useNativeBalance } from "@/lib/native";
import { AmountInput, Button, ChipRow, DateTime, DetailRows, Modal, OutcomeStrip, Segmented, StepsLine, TokenButton, TokenIcon, TxErrorLine, stageLabel, useLiveNow } from "../ui";
import { OrderStatus, RoundPill } from "../common/Status";
import { useWithdraw } from "../common/useWithdraw";
import { SummaryDetails } from "../common/SummaryDetails";

export const MOVES = [50, 100, 300];
export const ROUNDS = [1, 2, 4, 12];

export type BorrowOrder = ReturnType<typeof useBorrowOrder>;

/**
 * `payNative`: the person pays in HYPE / MON for a WHYPE / WMON market (IA v3.1 item 11). The balance and "Not enough"
 * then read the native coin, and the wrap is the first step of the same order. `receiveNative`: the person receives HYPE /
 * MON from a market lending WHYPE / WMON; the proceeds are withdrawn and unwrapped in one button flow once filled.
 */
export function useBorrowOrder({ pool, A, Q, amount, ref, payNative = false, receiveNative = false }: { pool?: PoolRow; A?: Token; Q?: Token; amount: string; ref?: number | null; payNative?: boolean; receiveNative?: boolean }) {
  const { chainId, deployment } = useActiveChain();
  const { address } = useConnection();
  const { now: chainNow, block } = useChainClock();
  const live = useLiveNow();
  const now = live || chainNow;
  const spb = useBlockTime().data;
  const [priceMode, setPriceMode] = useState<"market" | "own">("market");
  const [limitStr, setLimitStr] = useState("");
  const [moveBps, setMoveBps] = useState<number>();
  const [rounds, setRounds] = useState<number>();
  const [settings, setSettings] = useState(false);
  const [review, setReview] = useState(false);
  const [watch, setWatch] = useState<(WatchStart & { chainId: number }) | "signing">();

  const units = A ? parseAmount(amount, A.decimals) : 0n;
  const refUnits = refToUnits(ref ?? undefined, Q?.decimals);
  const priced = !!pool && lastTraded(pool) > 0n;
  const ownPrice = priceMode === "own" || (!!pool && !priced);
  // orders go in at this round's price itself, no discount
  const move = moveBps ?? 0;
  const fallbackLimit = pool ? (refUnits ? (refUnits * BigInt(10_000 - move)) / 10_000n : defaultBorrowLimit(pool)) : 0n;
  const limit = Q && limitStr ? parseAmount(limitStr, Q.decimals) : fallbackLimit;
  const q: BorrowQuote | undefined = pool ? borrowQuote({ pool, units, ref: refUnits, now, moveBps: move, limit: ownPrice ? limit : undefined }) : undefined;
  const one = A ? 10n ** BigInt(A.decimals) : 0n;
  const show = units > 0n ? units : one;
  const qs: BorrowQuote | undefined = pool ? borrowQuote({ pool, units: show, ref: refUnits, now, moveBps: move, limit: ownPrice ? limit : undefined }) : undefined;
  const tries = rounds ?? (pool ? defaultTtl(pool) : 4);
  const deadline: Deadline | undefined = pool ? repayDeadline(pool, { now, block, spb, windowBlocks: deployment?.windowBlocks ?? 0 }) : undefined;

  // a pool that never traded takes only an order at your own minimum: open the settings on it
  const poolId = pool?.id;
  useEffect(() => {
    if (pool && !priced) {
      setPriceMode("own");
      setSettings(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolId, priced]);
  useEffect(() => {
    setLimitStr("");
  }, [poolId]);
  useEffect(() => {
    if (Q && pool && ownPrice && !limitStr && fallbackLimit > 0n) setLimitStr(toInput(fallbackLimit, Q.decimals));
  }, [Q, pool, ownPrice, limitStr, fallbackLimit]);

  const balQ = useBalances(A ? [A.address] : []);
  const nativeBal = useNativeBalance(chainId);
  const nat = nativeTokenOf(chainId);
  const payToken: Token | undefined = payNative ? nat : A;
  const bal = payNative ? nativeBal : balQ.data?.[A?.address.toLowerCase() ?? ""];
  /** The most this order can take from the wallet (the native coin keeps a little for gas). */
  const maxPay = payNative && bal !== undefined ? spendableNative(bal, chainId) : bal;
  const minN = useMinNotional(Q?.address).data;
  const min = pool ? minUnits(pool, minN) : 0n;
  const allowance = useAllowance(A?.address).data;
  const positions = usePositions(pool ? [pool.id] : []).data;
  const pending = usePending(pool ? [pool.asset, pool.quote] : []).data;
  const myOrders = useAccountOrders().data;
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const watchState = useOrderWatch(watch && watch !== "signing" ? watch : undefined);
  const withdraw = useWithdraw();

  const balanceShort = !!address && maxPay !== undefined && units > maxPay;
  const belowMin = units > 0n && units < min;
  const needsApprove = !!address && allowance !== undefined && units > 0n && allowance < units;
  const bbPrice = pool ? buyBack(pool) : 0n;
  const anchor = pool && priced ? lastTraded(pool) : refUnits;
  const limitTooHigh = ownPrice && !!pool && limit >= bbPrice;
  const limitLow = ownPrice && !!anchor && limit > 0n && limit < (anchor * 9n) / 10n;
  const scale = pool ? scaleOf(pool.assetDecimals) : 1n;
  // net of the v0.8 fees at the guard price: 0.015% trade fee and 5% of (buy-back − price)
  const floor = q && pool && !ownPrice ? netAtPrice(pool, show, q.guard) : undefined;

  const sym = payToken?.symbol ?? "";
  let label: string;
  let can = false;
  if (!pool) label = "No open market";
  else if (!amount || units === 0n) label = "Enter an amount";
  else if (belowMin) label = `Minimum is ${fmtToken(min, A)}`;
  else if (limitTooHigh) label = "Lower your price";
  else if (!q || q.receive === 0n) label = "Set a price in settings";
  else if (address && bal === undefined && (payNative || balQ.isLoading)) label = "Loading balance…";
  else if (balanceShort) label = `Not enough ${sym}`;
  else if (payNative) {
    label = `Wrap ${nat.symbol} and borrow`;
    can = true;
  } else if (needsApprove) {
    label = `Approve ${sym}`;
    can = true;
  } else {
    label = `Borrow ${fmtToken(q.receive, Q)}`;
    can = true;
  }

  const place = async (onDone?: () => void) => {
    if (!ctx || !pool || !A || !Q || !q) return;
    const before = {
      held: positions?.[pool.id]?.r ?? 0n,
      pendingQuote: pending?.[pool.quote.toLowerCase()] ?? 0n,
      pendingAsset: pending?.[pool.asset.toLowerCase()] ?? 0n,
      orderIds: (myOrders ?? []).filter((o) => o.pid.toLowerCase() === pool.id.toLowerCase()).map((o) => String(o.id)),
    };
    setWatch("signing");
    const r = await tx.run(() => borrowWrites(ctx, { pool, units, asset: A, mode: ownPrice ? "limit" : "at-price", limit: ownPrice ? limit : undefined, slippageBps: move, rounds: tries, payNative: payNative ? nat.symbol : undefined }), { successMessage: "Borrow order submitted" });
    if (r.ok) {
      setReview(false);
      setWatch({ pool, side: "borrow", rounds: tries, amount: units, before, chainId });
      onDone?.();
    } else setWatch(undefined);
  };

  const onWithdraw = () => {
    if (!A || !Q) return;
    const filled = watchState?.phase === "filled";
    const tok = filled ? Q : A;
    const amt = pending?.[tok.address.toLowerCase()] ?? 0n;
    const unwrap = filled && receiveNative && isWrappedNative(chainId, Q.address) ? nat.symbol : undefined;
    if (amt > 0n) void withdraw.run([{ token: tok.address, amount: amt, meta: tok, unwrap }]);
  };

  const termLen = pool ? fmtWait(Math.max(0, pool.expiry - now)) : "";
  const rateText = (x?: BorrowQuote) => (x ? (x.showApr ? `${pct(x.apr)} APR` : `${pct(x.periodReturn)} for ${termLen}`) : "—");

  return {
    pool, A, Q, now, block, chainId, address, units, show, one, refUnits, priced, ownPrice, priceMode, setPriceMode, limitStr, setLimitStr, limit, move, setMoveBps, tries, setRounds,
    settings, setSettings, review, setReview, watch, setWatch, watchState, q, qs, deadline, bal, min, balanceShort, belowMin, needsApprove, bbPrice, anchor, limitTooHigh, limitLow, floor,
    label, can, place, onWithdraw, tx, termLen, rateText, ref, payNative, payToken, maxPay, receiveNative: receiveNative && !!Q && isWrappedNative(chainId, Q.address), nat,
  };
}

/** "Repay by" as a node: the deadline estimate, or the maturity plus the window when the block time is unknown. */
export function DeadlineText({ o }: { o: BorrowOrder }) {
  if (!o.pool || !o.deadline) return null;
  return o.deadline.known ? <DateTime ts={o.deadline.ts} approx /> : <><DateTime ts={o.pool.expiry} /> + repayment window</>;
}

/** Order settings: market or own price, the worst accepted price or the limit, rounds to keep trying; reference prices, display only. */
export function BorrowSettings({ o, marketLink = true }: { o: BorrowOrder; marketLink?: boolean }) {
  const { pool, A, Q } = o;
  const lt = launchTokensOf(o.chainId);
  if (!pool || !A || !Q) return null;
  return (
    <div className="well space-y-4 px-4 py-4 text-body-sm" data-testid="order-settings">
      <Segmented
        label="Price"
        value={o.ownPrice ? "own" : "market"}
        onChange={(v) => o.setPriceMode(v)}
        options={[
          { value: "market", label: "Market", disabled: !o.priced },
          { value: "own", label: "Limit" },
        ]}
      />
      {o.ownPrice ? (
        <div className="space-y-2">
          <AmountInput
            big={false}
            label={`Limit price per ${A.symbol}`}
            value={o.limitStr}
            onChange={o.setLimitStr}
            decimals={Q.decimals}
            token={<TokenButton symbol={Q.symbol} address={Q.address} />}
            error={o.limitTooHigh ? `Above the buy-back price ${fmtPer(o.bbPrice, Q)}. No lender pays more.` : undefined}
          />
          <div className="flex flex-wrap gap-2">
            {o.priced && (
              <button type="button" className="chip h-8 text-caption" onClick={() => o.setLimitStr(toInput(lastTraded(pool), Q.decimals))}>
                Last traded {fmtPer(lastTraded(pool), Q)}
              </button>
            )}
            {o.refUnits && (
              <button type="button" className="chip h-8 text-caption" onClick={() => o.setLimitStr(toInput(o.refUnits!, Q.decimals))}>
                Market {fmtPer(o.refUnits, Q)}
              </button>
            )}
          </div>
          {o.limitLow && o.anchor && <p className="text-caption text-warn">{pct(1 - Number(o.limit) / Number(o.anchor), 0)} below {o.priced ? "last traded" : "market"}: you would receive much less than the market pays.</p>}
        </div>
      ) : (
        <p className="text-caption text-ink-2">Fills at this round&apos;s price, the same for every borrower, or waits for the next round.</p>
      )}
      <ChipRow label="Valid for" value={o.tries} onChange={o.setRounds} options={ROUNDS.map((n) => ({ value: n, label: `${n} round${n > 1 ? "s" : ""}` }))} helper={`≈ ${fmtWait(o.tries * roundSeconds(pool))}; unfilled collateral is returned.`} />
      <p className="tabular-nums text-caption text-ink-3">
        {o.priced ? `Last traded ${fmtPer(lastTraded(pool), Q)}` : "Not traded yet"}
        {o.ref ? `. Reference ${fmtPer(o.refUnits, Q)} (${priceSource(o.chainId, A.address, Q.address, { lst: lt.lst, native: lt.native, assetSymbol: A.symbol })}, display only)` : ""}
      </p>
      {marketLink && (
        <Link href={`/borrow?pool=${pool.id}`} className="link text-caption">
          Market details
        </Link>
      )}
    </div>
  );
}

/**
 * The deal as label / value rows, per 1 unit of collateral until an amount is typed. `collapsible` (home card): one
 * summary row (what to repay, by when, at what rate) with a chevron; the full list opens below it. Nothing is dropped,
 * and the worst-case sentence stays visible either way.
 */
export function BorrowTerms({ o, testId = "borrow-terms", collapsible = false, top, footer }: { o: BorrowOrder; testId?: string; collapsible?: boolean; /** Shown first when the details open. */ top?: React.ReactNode; /** Shown last inside the folded details (the home card's round timing). */ footer?: React.ReactNode }) {
  const { pool, A, Q, qs } = o;
  if (!pool || !A || !Q || !qs) return null;
  const per = o.units > 0n ? "" : ` per 1 ${A.symbol}`;
  const left = Math.max(0, (o.deadline?.known ? o.deadline.ts : pool.expiry) - o.now);
  const vsMarket = o.refUnits && o.bbPrice ? Number(o.bbPrice - o.refUnits) / Number(o.refUnits) : undefined;
  const rows = (
    <DetailRows
      rows={[
        { k: "Fixed rate", v: o.rateText(qs), hint: qs.showApr ? `${pct(qs.periodReturn)} over ${o.termLen}` : undefined, testId: "row-rate" },
        { k: `You receive${per}`, v: <>{o.ownPrice ? "at least " : "≈ "}{fmtToken(qs.receive, Q)}</>, hint: o.floor !== undefined && o.units > 0n ? `at least ${fmtToken(o.floor, Q)} (price may move ${o.move / 100}%)` : undefined },
        { k: `Repay${per}`, v: fmtToken(qs.repay, Q), testId: "row-repay" },
        { k: "Repay by", v: <DeadlineText o={o} />, hint: left > 0 ? `in ${fmtWait(left)}${repaysAnyTime(pool) ? ", any time before" : ", only after maturity"}` : undefined },
        { k: "Interest", v: fmtToken(qs.repay - qs.receive > 0n ? qs.repay - qs.receive : 0n, Q), hint: "fees included" },
        vsMarket !== undefined && { k: "Buy-back price", v: `${fmtPer(o.bbPrice, Q)} ${Q.symbol}`, hint: `${vsMarket >= 0 ? "+" : ""}${pct(vsMarket, 1)} vs market (reference)` },
        { k: "Fees", v: fmtToken(qs.tradeFee + qs.spreadShare, Q), hint: `0.015% trade fee ${fmtToken(qs.tradeFee, Q)} + 5% of the interest ${fmtToken(qs.spreadShare, Q)}; nothing on repay`, testId: "row-fees" },
      ]}
    />
  );
  const ifNot = <p className="mt-3 text-caption text-ink-3">If you don&apos;t repay: you keep the {Q.symbol}, lenders keep the {A.symbol}. No liquidation, nothing else happens.</p>;
  return (
    <div data-testid={testId}>
      {collapsible ? (
        <SummaryDetails testId={testId} summary={borrowSummary(o)}>
          {top && <div className="mb-4">{top}</div>}
          {rows}
          {ifNot}
          {footer && <div className="mt-3">{footer}</div>}
        </SummaryDetails>
      ) : (
        <>
          {rows}
          {ifNot}
        </>
      )}
    </div>
  );
}

/** The folded details in one line: "3.63% fixed · repay 34.00 USDC by 02:04 UTC". */
export function borrowSummary(o: BorrowOrder): string {
  const { pool, Q, qs, A } = o;
  if (!pool || !Q || !qs || !A) return "";
  const rate = qs.price === 0n ? "No price yet" : `${qs.showApr ? `${pct(qs.apr)} APR` : pct(qs.periodReturn)} fixed`;
  const by = o.deadline?.known ? `≈ ${fmtClock(o.deadline.ts)}` : `${fmtClock(pool.expiry)} + window`;
  return `${rate} · repay ${fmtToken(qs.repay, Q)}${o.units > 0n ? "" : ` per ${A.symbol}`} by ${by}`;
}

/** The round pill, replaced by the order's progress after it is submitted. */
export function BorrowStatus({ o }: { o: BorrowOrder }) {
  const { pool, A, Q, watch } = o;
  if (!pool || !A || !Q) return null;
  if (!watch) return <RoundPill pool={pool} now={o.now} block={o.block} />;
  return (
    <OrderStatus
      watch={watch === "signing" ? "signing" : ((o.watchState as WatchState | undefined) ?? { phase: "placed", round: 1, of: o.tries, received: 0n, units: 0n, refund: 0n })}
      side="borrow"
      asset={A}
      quote={Q}
      pool={watch === "signing" ? pool : watch.pool}
      now={o.now}
      onWithdraw={o.onWithdraw}
      onDismiss={() => o.setWatch(undefined)}
    />
  );
}

/** Review before signing: what you give and get, the rows, both outcomes, where the proceeds go; approval runs inside. */
export function BorrowReview({ o, onPlaced }: { o: BorrowOrder; onPlaced?: () => void }) {
  const { pool, A, Q, q } = o;
  if (!pool || !A || !Q || !q) return null;
  const placing = o.tx.busy;
  const anyTime = repaysAnyTime(pool);
  return (
    <Modal open={o.review} onClose={() => !placing && o.setReview(false)} title="Review borrow" testId="review-modal">
      <div className="space-y-4">
        <div className="well space-y-3 px-4 py-3">
          <ReviewLine label="You pay" amount={fmtToken(o.units, o.payToken ?? A, false)} token={o.payToken ?? A} />
          <ReviewLine label="You receive" amount={fmtToken(q.receive, Q, false)} token={o.receiveNative ? { ...Q, address: o.nat.address, symbol: o.nat.symbol } : Q} prefix={o.ownPrice ? "at least " : "≈ "} />
          <p className="text-caption text-ink-2">
            Plus the right to buy back <span className="num">{fmtToken(o.units, A)}</span> for <span className="num">{fmtToken(q.repay, Q)}</span>.
          </p>
        </div>
        <DetailRows
          rows={[
            { k: "Fixed rate", v: o.rateText(q) },
            { k: "Repay", v: fmtToken(q.repay, Q) },
            { k: "Repay by", v: <DeadlineText o={o} />, hint: anyTime ? "any time before" : "only after maturity" },
            o.floor !== undefined && { k: "You receive at least", v: fmtToken(o.floor, Q), hint: "or the order waits for the next round" },
            { k: "Valid for", v: `${o.tries} round${o.tries > 1 ? "s" : ""}`, hint: `≈ ${fmtWait(o.tries * roundSeconds(pool))}` },
            { k: "Fees", v: fmtToken(q.tradeFee + q.spreadShare, Q), hint: "0.015% trade fee + 5% of the interest, taken from what you receive; nothing on repay" },
          ]}
        />
        <OutcomeStrip
          left={{ title: "If you repay", body: <>Pay <span className="num">{fmtToken(q.repay, Q)}</span> and get your <span className="num">{fmtToken(o.units, A)}</span> back.</> }}
          right={{ title: `If you don't repay by ${o.deadline?.known ? `≈ ${fmtClock(o.deadline.ts)}` : "the deadline"}`, body: <>You keep the <span className="num">{fmtToken(q.receive, Q)}</span>, lenders keep your <span className="num">{fmtToken(o.units, A)}</span>. Nothing else happens.</> }}
        />
        <ul className="list-disc space-y-1 pl-5 text-caption text-ink-3">
          <li>Your order fills at the next round (about {fmtWait(roundSeconds(pool))}); every borrower in a round gets the same price. You can cancel until then.</li>
          <li>When it fills, the {Q.symbol} waits under Portfolio, Ready to withdraw (one more transaction). If it doesn&apos;t fill, your {A.symbol} comes back the same way.</li>
          {o.payNative && <li>Your {o.payToken?.symbol} is wrapped into {A.symbol} (1:1) as the first step. Anything returned comes back as {A.symbol}.</li>}
          {o.receiveNative && <li>The loan is lent in {Q.symbol}; when you withdraw it, it is unwrapped to {o.nat.symbol} (1:1) in the same step.</li>}
          {o.needsApprove && <li>First time only: one permission lets the Confluere contract use your {A.symbol}.</li>}
        </ul>
        <TxErrorLine error={o.tx.lastError} />
        <Button variant="primary" size="lg" block loading={placing} onClick={() => void o.place(onPlaced)} data-testid="place-order">
          {stageLabel(o.tx.steps, placing ? "Submitting…" : o.payNative ? (o.needsApprove ? `Wrap ${o.payToken?.symbol}, approve and borrow` : `Wrap ${o.payToken?.symbol} and borrow`) : o.needsApprove ? `Approve ${A.symbol} and borrow` : "Confirm borrow")}
        </Button>
        <StepsLine steps={o.tx.steps} labels={reviewSteps(o, A.symbol)} />
      </div>
    </Modal>
  );
}

/** The step list shown before signing: the wrap (native coin), the approval (first time), then the order. */
export function reviewSteps(o: { payNative: boolean; needsApprove: boolean; payToken?: Token }, sym: string, last = "Borrow"): string[] | undefined {
  const s = [o.payNative ? `Wrap ${o.payToken?.symbol ?? ""}` : "", o.needsApprove ? `Approve ${sym}` : "", last].filter(Boolean);
  return s.length > 1 ? s : undefined;
}

export function ReviewLine({ label, amount, token, prefix = "" }: { label: string; amount: string; token: Token; prefix?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-caption text-ink-2">{label}</span>
      <span className="flex items-center gap-2">
        <span className="num text-caption text-ink-3">{prefix}</span>
        <span className="num text-amount font-semibold">{amount}</span>
        <TokenIcon symbol={token.symbol} address={token.address} size={24} />
        <span className="text-body-sm font-medium">{token.symbol}</span>
      </span>
    </div>
  );
}
