"use client";

/**
 * Lend into one pool (the "get C" side of a market, IA v3.1 item 2). The lender buys lender units below the buy-back price: paid the buy-back
 * price per unit if the borrower buys back, otherwise the borrower's tokens.
 */
import Link from "next/link";
import { useState } from "react";
import { useConnection } from "wagmi";
import type { Hex } from "viem";
import { quoteDown, scaleOf } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { launchTokensOf } from "@/lib/chains";
import { useAccountOrders, useMinNotional, usePools, useTokens, tokenOf, type PoolRow } from "@/lib/data";
import { usePending, usePositions } from "@/lib/position";
import { useActionCtx, useChainClock } from "@/lib/useProduct";
import { useRefPrice } from "@/lib/refPrice";
import { lendQuote, netReturn, rateText, refToUnits } from "@/lib/quote";
import { defaultSlippageBps, lendCap, lendWrites } from "@/lib/actions";
import { buyEscrow } from "@confluere/sdk";
import { defaultCap, defaultTtl } from "@/lib/order";
import { useAllowance } from "@/lib/allowance";
import { useOrderWatch, type WatchStart } from "@/lib/orderStatus";
import { useTx } from "@/lib/tx";
import { fmtChip, fmtExpiry, fmtPer, fmtToken, fmtWait, parseAmount, pct, toInput } from "@/lib/format";
import { buyBack, lastTraded, repaysAnyTime, roundSeconds, takesOrders, unitScale } from "@/lib/view";
import { positionName, priceSource } from "@/lib/vocab";
import { AmountInput, Button, ChipRow, DetailRows, Disclosure, OutcomeStrip, Segmented, StepsLine, TokenButton, TxErrorLine, stageLabel, useLiveNow } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { reviewSteps } from "./borrowFlow";
import { TokenShortfall } from "../common/TokenShortfall";
import { OrderStatus, RoundPill } from "../common/Status";
import { useWithdraw } from "../common/useWithdraw";
import { usePayWith } from "../common/PayWith";

const ROUNDS = [1, 2, 4, 12];
const MOVES = [50, 100, 300];

/**
 * Lend into one pool: the "get C" side of a market's trade card. `embedded` drops the sticky footer a drawer needs.
 */
export function LendForm({ poolId, onClose, embedded }: { poolId: Hex; onClose?: () => void; embedded?: boolean }) {
  const pool = (usePools().data ?? []).find((p) => p.id === poolId);
  // the pool list may still be loading when the form opens from a link
  if (!pool) return <div className="skeleton h-[320px]" aria-busy aria-label="Loading" />;
  return <LendFormFor pool={pool} onClose={onClose} embedded={embedded} />;
}

function LendFormFor({ pool, onClose, embedded }: { pool: PoolRow; onClose?: () => void; embedded?: boolean }) {
  const { chainId } = useActiveChain();
  const { address } = useConnection();
  const tokens = useTokens([pool.asset, pool.quote]).data;
  const allPools = usePools().data;
  const A = tokenOf(tokens, pool.asset)!;
  const Q = tokenOf(tokens, pool.quote)!;
  const { now: cn, block } = useChainClock();
  const now = useLiveNow() || cn;
  const ref = useRefPrice(pool.asset, pool.quote).data;
  const refUnits = refToUnits(ref, Q?.decimals);
  const [amount, setAmount] = useState("");
  const [own, setOwn] = useState(lastTraded(pool) === 0n);
  const [limitStr, setLimitStr] = useState(() => (Q ? toInput(defaultCap(pool), Q.decimals) : ""));
  const [rounds, setRounds] = useState(defaultTtl(pool));
  // lend orders go in at this round's price itself, no premium
  const [move, setMove] = useState(0);
  const [watch, setWatch] = useState<(WatchStart & { chainId: number }) | "signing">();
  const amt = Q ? parseAmount(amount, Q.decimals) : 0n;
  const limit = Q ? parseAmount(limitStr, Q.decimals) : 0n;
  const q = lendQuote({ pool, amount: amt, ref: refUnits, now, limit: own ? limit : undefined });
  const escrow = own ? buyEscrow(q.units, limit, rounds, unitScale(pool)) : amt;
  const pw = usePayWith(Q);
  const bal = pw.bal;
  const allowance = useAllowance(pool.quote).data;
  const minN = useMinNotional(pool.quote).data ?? 0n;
  const positions = usePositions([pool.id]).data;
  const pending = usePending([pool.asset, pool.quote]).data;
  const myOrders = useAccountOrders().data;
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const watchState = useOrderWatch(watch && watch !== "signing" ? watch : undefined);
  const withdraw = useWithdraw();
  const lt = launchTokensOf(chainId);
  if (!A || !Q) return null;
  const open = takesOrders(pool, now, block);
  const bbPrice = buyBack(pool);
  const scale = scaleOf(pool.assetDecimals);
  if (!open)
    return (
      <div className="space-y-3">
        <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-body-sm text-ink-2">This market matured on {fmtExpiry(pool.expiry)} and no longer takes orders.</p>
        {onClose && (
          <Button variant="secondary" size="md" onClick={onClose}>
            See open markets
          </Button>
        )}
      </div>
    );
  const short = !!address && pw.max !== undefined && escrow > pw.max;
  const P = pw.P ?? Q;
  const needsApprove = !!address && allowance !== undefined && escrow > 0n && allowance < escrow;
  const tooSmall = amt > 0n && amt < minN;
  const tooHigh = own && limit >= bbPrice;
  const cap = own ? limit : lendCap(pool, move);
  const price = q.price > 0n ? q.price : lastTraded(pool) || refUnits || 0n;
  const f = netReturn(pool, now, price);
  const worst = netReturn(pool, now, cap);
  let label = "Enter an amount";
  let can = false;
  if (amt === 0n) label = "Enter an amount";
  else if (tooSmall) label = `Minimum is ${fmtToken(minN, Q)}`;
  else if (tooHigh) label = "Lower your price";
  else if (q.units === 0n) label = "Set a limit price below";
  else if (short) label = `Not enough ${P.symbol}`;
  else {
    label = pw.native ? `Wrap ${P.symbol} and lend` : `Lend ${fmtToken(amt, Q)}`;
    can = true;
  }

  const place = async () => {
    if (!ctx) return;
    const before = {
      held: positions?.[pool.id]?.c ?? 0n,
      pendingQuote: pending?.[pool.quote.toLowerCase()] ?? 0n,
      pendingAsset: pending?.[pool.asset.toLowerCase()] ?? 0n,
      orderIds: (myOrders ?? []).filter((o) => o.pid.toLowerCase() === pool.id.toLowerCase()).map((o) => String(o.id)),
    };
    setWatch("signing");
    const r = await tx.run(() => lendWrites(ctx, { pool, amount: amt, quote: Q, mode: own ? "limit" : "at-price", units: own ? q.units : undefined, limit: own ? limit : undefined, rounds, slippageBps: move, payNative: pw.nativeSymbol }), { successMessage: "Lend order submitted" });
    if (r.ok) {
      setWatch({ pool, side: "lend", rounds, amount: amt, before, chainId });
      setAmount("");
    } else setWatch(undefined);
  };

  // facts per 1 unit of collateral until an amount is typed (Pendle PT panel: rate, maturity, payout before input)
  const units = amt > 0n && q.units > 0n ? q.units : 10n ** BigInt(A.decimals);
  const paid = amt > 0n ? amt : quoteDown(units, price, scale);
  const payout = quoteDown(units, f.netPerUnit || bbPrice, scale);
  const per = amt > 0n ? "" : ` per 1 ${A.symbol}`;
  const fee = (quoteDown(units, bbPrice, scale) - payout);
  const ft = positionName("ft", pool, A, Q, { all: allPools ?? [] });

  return (
    <div className="space-y-4">
      <AmountInput
        label="You lend"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        autoFocus
        decimals={Q.decimals}
        token={pw.button}
        helper={minN > 0n ? <span className="num">Min {fmtToken(minN, Q)}</span> : undefined}
        balance={address ? <span className="num">Balance {fmtToken(bal ?? 0n, P)}</span> : undefined}
        onMax={address && pw.max ? () => setAmount(toInput(pw.max!, Q.decimals)) : undefined}
        testId="lend-input"
      />
      {pw.picker}
      {short && <TokenShortfall token={Q} need={escrow} onUseNative={pw.can && !pw.native ? () => pw.setNative(true) : undefined} />}
      <div data-testid="lend-terms">
        <DetailRows
          rows={[
            amt > 0n && q.units > 0n && { k: "You receive", v: <span title={ft.symbol}>≈ {fmtToken(q.units, { symbol: ft.short, decimals: A.decimals })}</span>, hint: `1 C = 1 ${A.symbol} of backing`, testId: "lend-receive" },
            { k: "Fixed rate", v: price > 0n ? rateText(f, pool.expiry - now) : "—", hint: "net of the protocol's share" },
            { k: `You pay${per}`, v: <>≈ {fmtToken(paid, Q)}</>, hint: price > 0n ? `${fmtPer(price, Q)} ${Q.symbol} per ${A.symbol}` : undefined },
            { k: `Paid back${per}`, v: fmtToken(payout, Q), hint: `on ${fmtChip(pool.expiry)} UTC, if repaid` },
            !own && { k: "Worst case", v: worst.priced ? rateText(worst, pool.expiry - now) : "—", hint: `you pay at most ${fmtPer(cap, Q)} per ${A.symbol}` },
            { k: "Collateral", v: `${A.symbol}, bought back at ${fmtPer(bbPrice, Q)}`, hint: refUnits ? `${pct(Number(bbPrice - refUnits) / Number(refUnits), 1)} vs market (reference)` : undefined },
            { k: "Fee", v: fee > 0n ? fmtToken(fee, Q) : "None", hint: "share of the interest, only if repaid" },
            { k: "Repayment", v: repaysAnyTime(pool) ? "Any time" : "At maturity", hint: repaysAnyTime(pool) ? "you may be paid back early" : undefined },
          ]}
        />
      </div>
      {own && amt > 0n && <p className="text-caption text-ink-3">Held while trying: <span className="num">{fmtToken(escrow, Q)}</span>. The unused part returns to Ready to withdraw.</p>}
      <OutcomeStrip
        left={{ title: "If the borrower repays", body: <>You receive <span className="num">{fmtToken(payout, Q)}</span>.</> }}
        right={{ title: "If not", body: <>You receive <span className="num">{fmtToken(units, A)}</span> instead, bought at {fmtPer(price, Q)} {Q.symbol} each. You only lose if {A.symbol} is then worth less.</> }}
      />
      {watch ? (
        <OrderStatus
          watch={watch === "signing" ? "signing" : (watchState ?? { phase: "placed", round: 1, of: rounds, received: 0n, units: 0n, refund: 0n })}
          side="lend"
          asset={A}
          quote={Q}
          pool={pool}
          now={now}
          onWithdraw={() => {
            const amtP = pending?.[Q.address.toLowerCase()] ?? 0n;
            if (amtP > 0n) void withdraw.run([{ token: Q.address, amount: amtP, meta: Q }]);
          }}
          onDismiss={() => setWatch(undefined)}
        />
      ) : (
        <RoundPill pool={pool} now={now} block={block} />
      )}
      <Disclosure title="Order settings" open={lastTraded(pool) === 0n ? true : undefined}>
        <div className="space-y-4 text-body-sm">
          <Segmented
            label="Price"
            value={own ? "own" : "market"}
            onChange={(v) => setOwn(v === "own")}
            options={[
              { value: "market", label: "Market", disabled: lastTraded(pool) === 0n },
              { value: "own", label: "Limit" },
            ]}
          />
          {own ? (
            <AmountInput big={false} label={`Limit price per ${A.symbol}`} value={limitStr} onChange={setLimitStr} decimals={Q.decimals} token={<TokenButton symbol={Q.symbol} address={Q.address} />} error={tooHigh ? `At or above the buy-back price ${fmtPer(bbPrice, Q)}: you would be paid back less than you lend.` : undefined} />
          ) : (
            <p className="text-caption text-ink-2">Fills at this round&apos;s price, the same for every lender, or waits for the next round.</p>
          )}
          <ChipRow label="Valid for" value={rounds} onChange={setRounds} options={ROUNDS.map((n) => ({ value: n, label: `${n} round${n > 1 ? "s" : ""}` }))} helper={`≈ ${fmtWait(rounds * roundSeconds(pool))}; unfilled funds are returned.`} />
          <p className="tabular-nums text-caption text-ink-3">
            {lastTraded(pool) > 0n ? `Last traded ${fmtPer(lastTraded(pool), Q)}` : "Not traded yet"}
            {ref ? ` · Reference ${fmtPer(refUnits, Q)} (${priceSource(chainId, A.address, Q.address, { lst: lt.lst, native: lt.native, assetSymbol: A.symbol })}, display only)` : ""}
          </p>
          <Link href={`/markets?pool=${pool.id}`} className="link text-caption">
            Round-by-round details
          </Link>
        </div>
      </Disclosure>
      <div className={embedded ? "space-y-2 pt-1" : "sticky bottom-0 -mx-6 space-y-2 bg-surface px-6 pb-1 pt-3 shadow-[0_-1px_0_var(--line)] max-lg:-mx-4 max-lg:px-4"}>
        <TxErrorLine error={tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!can || tx.busy} loading={tx.busy} onClick={() => void place()} data-testid="lend-button">
            {stageLabel(tx.steps, label)}
          </Button>
        </WalletAction>
        <StepsLine steps={tx.steps} labels={can ? reviewSteps({ payNative: pw.native, needsApprove, payToken: P }, Q.symbol, "Lend") : undefined} />
        {pw.native && can && <p className="text-center text-caption text-ink-3">Your {P.symbol} is wrapped into {Q.onchainSymbol ?? Q.symbol} (1:1) first; anything returned comes back as {Q.onchainSymbol ?? Q.symbol}.</p>}
        {needsApprove && can && <p className="text-center text-caption text-ink-3">First time only: one permission lets the Confluere contract use your {Q.symbol}.</p>}
      </div>
    </div>
  );
}
