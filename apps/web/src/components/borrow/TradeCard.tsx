"use client";

/**
 * The trade card of a market drawer (IA v3.1 item 2; Pendle's PT / YT card). First pick the token, then the action:
 * - C, the lender token: Lend (a new position, filled in the next round) · Buy · Sell (from and to other holders).
 * - R, the buy-back right: Borrow (deposit collateral, receive the quote token and R) · Buy · Sell, plus Repay when you
 *   hold R that can be used now.
 * Buy and Sell go through the position market (instant at listed prices, or listed at your own price). In the demo
 * (IA v3.1 item 13) Sell fills at the sample network's market price (lib/demo/sell).
 */
import { PositionBuy, PositionButton, PositionSell } from "./SellPosition";
import { useState } from "react";
import { useConnection } from "wagmi";
import { repayAmount, scaleOf } from "@confluere/sdk";
import type { PoolRow, Token } from "@/lib/data";
import { useRefPrice } from "@/lib/refPrice";
import { netReturn } from "@/lib/quote";
import { fmtExpiry, fmtPer, fmtToken, parseAmount, toInput } from "@/lib/format";
import { useActiveChain } from "@/lib/activeChain";
import { useBalances, usePositions } from "@/lib/position";
import { useTx } from "@/lib/tx";
import { useDemo } from "@/lib/demo/mode";
import { DEMO_BUY_FN, DEMO_SELL_FN, sellMinOut, buyCost, buyMaxIn, sellOut, sellPrice } from "@/lib/demo/sell";
import { canRepay } from "@/lib/window";
import { buyBack, lastTraded, takesOrders } from "@/lib/view";
import { useChainClock } from "@/lib/useProduct";
import { POSITION, type PositionKind } from "@/lib/vocab";
import type { BorrowPosition } from "@/lib/product";
import { AmountInput, Button, Card, DetailRows, Disclosure, Segmented, StepsLine, TxErrorLine, stageLabel, useLiveNow } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { TokenShortfall } from "../common/TokenShortfall";
import { RepayModal } from "../portfolio/Actions";
import { BorrowReview, BorrowSettings, BorrowStatus, BorrowTerms, useBorrowOrder } from "./borrowFlow";
import { LendForm } from "./LendForm";
import { usePayWith } from "../common/PayWith";
import { fixedWords, useBrPrice, usePositionNames, useRepayBy } from "./positionBits";

export type TradeToken = PositionKind;
export type TradeAction = "lend" | "borrow" | "buy" | "sell" | "repay";

/** Which action a token offers; the first opens a new position, the rest trade with holders. */
const ACTIONS: Record<PositionKind, { value: TradeAction; label: string }[]> = {
  ft: [
    { value: "lend", label: "Lend" },
    { value: "buy", label: "Buy" },
    { value: "sell", label: "Sell" },
  ],
  br: [
    { value: "borrow", label: "Borrow" },
    { value: "buy", label: "Buy" },
    { value: "sell", label: "Sell" },
  ],
};

export function TradeCard({
  pool,
  A,
  Q,
  initial = "br",
  initialAction,
  token: tokenIn,
  onToken,
  onClose,
}: {
  pool: PoolRow;
  A: Token;
  Q: Token;
  initial?: TradeToken;
  initialAction?: TradeAction;
  /** Controlled token (the drawer's token cards pick it too). */
  token?: TradeToken;
  onToken?: (t: TradeToken) => void;
  onClose?: () => void;
}) {
  const [tokenSt, setTokenSt] = useState<TradeToken>(initial);
  const token = tokenIn ?? tokenSt;
  const setToken = (t: TradeToken) => {
    setTokenSt(t);
    onToken?.(t);
  };
  const [action, setAction] = useState<TradeAction>(initialAction ?? (initial === "ft" ? "lend" : "borrow"));
  const { now: cn, block } = useChainClock();
  const now = useLiveNow() || cn;
  const open = takesOrders(pool, now, block);
  const f = netReturn(pool, now);
  const demo = useDemo();
  const names = usePositionNames(pool, A, Q);
  const br = useBrPrice(pool, Q);
  const pos = usePositions([pool.id]).data?.[pool.id];
  const free = pos && pos.r > pos.locked ? pos.r - pos.locked : 0n;
  const repayable = free > 0n && now > 0 && canRepay(pool, now, block);
  const tabs = token === "br" && repayable ? [...ACTIONS.br, { value: "repay" as const, label: "Repay" }] : ACTIONS[token];
  // keep Buy / Sell across a token switch; Lend and Borrow map onto each other
  const act: TradeAction = tabs.some((t) => t.value === action) ? action : action === "lend" || action === "borrow" || action === "repay" ? tabs[0]!.value : "buy";
  const price = (t: PositionKind) =>
    t === "ft" ? (lastTraded(pool) > 0n ? `${fmtPer(lastTraded(pool), Q)} ${Q.symbol}` : "No trades yet") : br.price ? `${br.estimate ? "≈ " : ""}${fmtPer(br.price, Q)} ${Q.symbol}` : "No offers yet";
  return (
    <Card className="p-4 sm:p-5" data-testid="trade-card">
      <div role="radiogroup" aria-label="Token" className="grid grid-cols-2 gap-2">
        {(["ft", "br"] as const).map((t) => {
          const on = token === t;
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setToken(t)}
              data-testid={`trade-${t}`}
              title={names[t].symbol}
              className={`flex flex-col justify-start rounded-[var(--radius-control)] px-3 py-2.5 text-left transition-colors ${on ? "bg-brand-soft text-brand-ink shadow-[inset_0_0_0_1px_var(--brand)]" : "bg-surface-2 text-ink hover:bg-[color-mix(in_oklch,var(--surface-2),var(--ink)_6%)]"}`}
            >
              <span className="block text-body-sm font-semibold">{POSITION[t].tab}</span>
              <span className="num mt-1 block text-caption font-medium">{price(t)}</span>
              <span className="block text-caption opacity-80">{t === "ft" ? (f.priced ? `${fixedWords(f)} if repaid` : "No rate yet") : `Buys back at ${fmtPer(buyBack(pool), Q)}`}</span>
            </button>
          );
        })}
      </div>
      <Segmented label={`${POSITION[token].prefix} action`} value={act} onChange={setAction} className="mt-3 w-full [&>button]:flex-1" options={tabs.map((t) => ({ ...t, testId: `trade-${t.value}` }))} />
      <div className="mt-4">
        {act === "sell" && demo && open ? (
          <DemoSell key={`${pool.id}-${token}`} pool={pool} A={A} Q={Q} token={token} />
        ) : act === "sell" ? (
          <PositionSell key={`${pool.id}-${token}`} pool={pool} A={A} Q={Q} token={token} />
        ) : act === "buy" && demo && open ? (
          <DemoBuy key={`${pool.id}-${token}`} pool={pool} A={A} Q={Q} token={token} />
        ) : act === "buy" ? (
          <PositionBuy key={`${pool.id}-${token}`} pool={pool} A={A} Q={Q} token={token} />
        ) : act === "repay" && pos ? (
          <RepayPanel pool={pool} A={A} Q={Q} free={free} locked={pos.locked} />
        ) : !open ? (
          <div className="space-y-3" data-testid="trade-closed">
            <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-body-sm text-ink-2">This market matured on {fmtExpiry(pool.expiry)} and no longer takes new positions.</p>
            {onClose && (
              <Button variant="secondary" size="md" onClick={onClose}>
                See open markets
              </Button>
            )}
          </div>
        ) : token === "br" ? (
          <PoolBorrowForm key={pool.id} pool={pool} A={A} Q={Q} />
        ) : (
          <LendForm key={pool.id} poolId={pool.id} embedded />
        )}
      </div>
    </Card>
  );
}

/** R · Repay: pay the buy-back price for the R you hold and take the collateral back (the Portfolio repay modal). */
function RepayPanel({ pool, A, Q, free, locked }: { pool: PoolRow; A: Token; Q: Token; free: bigint; locked: bigint }) {
  const { now, block } = useChainClock();
  const names = usePositionNames(pool, A, Q);
  const until = useRepayBy(pool);
  const [openModal, setOpen] = useState(false);
  const pay = repayAmount(free, buyBack(pool), scaleOf(pool.assetDecimals));
  const loan: BorrowPosition = { pool, units: free + locked, locked, free, repay: pay, canRepay: canRepay(pool, now, block), canRollover: false, lapsed: false, claimable: false };
  return (
    <div className="space-y-4" data-testid="trade-repay-panel">
      <DetailRows
        rows={[
          { k: "You pay", v: fmtToken(pay, Q), hint: `uses ${fmtToken(free, { symbol: names.br.prefix, decimals: A.decimals })}` },
          { k: "You receive", v: fmtToken(free, A) },
          { k: "Repay by", v: until.text },
          locked > 0n && { k: "Locked in an extension", v: fmtToken(locked, { symbol: names.br.prefix, decimals: A.decimals }) },
        ]}
      />
      <WalletAction>
        <Button variant="primary" size="lg" block onClick={() => setOpen(true)} data-testid="trade-repay-button">
          Repay
        </Button>
      </WalletAction>
      <RepayModal loan={openModal ? loan : undefined} asset={A} quote={Q} onClose={() => setOpen(false)} />
    </div>
  );
}

/** R · Borrow in a fixed pool: the same order as the home card, without the router. */
export function PoolBorrowForm({ pool, A, Q }: { pool: PoolRow; A: Token; Q: Token }) {
  const { address } = useConnection();
  const ref = useRefPrice(pool.asset, pool.quote).data;
  const [amount, setAmount] = useState("");
  const pw = usePayWith(A);
  const o = useBorrowOrder({ pool, A, Q, amount, ref, payNative: pw.native });
  const P = pw.P ?? A;
  const names = usePositionNames(pool, A, Q);
  return (
    <div className="space-y-4" data-testid="pool-borrow">
      <AmountInput
        label="You pay"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          o.tx.reset?.();
        }}
        readOnly={o.tx.busy}
        decimals={A.decimals}
        testId="pool-borrow-input"
        token={pw.button}
        helper={o.min > 0n ? <span className="num">Min {fmtToken(o.min, P)}</span> : undefined}
        balance={address ? <span className="num">Balance {fmtToken(o.bal ?? 0n, P)}</span> : undefined}
        onMax={address && o.maxPay ? () => setAmount(toInput(o.maxPay!, A.decimals)) : undefined}
      />
      {pw.picker}
      {o.balanceShort && <TokenShortfall token={A} need={o.units} onUseNative={pw.can && !pw.native ? () => pw.setNative(true) : undefined} />}
      <p className="text-body-sm tabular-nums text-ink-2" data-testid="pool-borrow-receive">
        {o.q && o.units > 0n && o.q.receive > 0n ? (
          <>
            You receive {o.ownPrice ? "at least" : "about"} <strong className="font-semibold text-ink">{fmtToken(o.q.receive, Q)}</strong> and{" "}
            <strong className="font-semibold text-ink" title={names.br.symbol}>
              {fmtToken(o.units, { symbol: names.br.short, decimals: P.decimals })}
            </strong>
            , your right to buy it back.
          </>
        ) : (
          <>
            You receive {Q.symbol} now and <span title={names.br.symbol}>{names.br.short}</span>, the right to buy your {A.symbol} back.
          </>
        )}
      </p>
      <BorrowTerms o={o} testId="pool-borrow-terms" />
      <Disclosure title="Order settings" open={o.settings || undefined} onToggle={o.setSettings}>
        <BorrowSettings o={o} marketLink={false} />
      </Disclosure>
      <BorrowStatus o={o} />
      <div className="space-y-2">
        <TxErrorLine error={o.review ? undefined : o.tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!o.can || o.tx.busy} loading={o.tx.busy} onClick={() => o.setReview(true)} data-testid="pool-borrow-button">
            {o.label}
          </Button>
        </WalletAction>
      </div>
      <BorrowReview o={o} onPlaced={() => setAmount("")} />
    </div>
  );
}


/** Demo only: sell C or R before maturity at the sample network's market price. */
function DemoSell({ pool, A, Q, token }: { pool: PoolRow; A: Token; Q: Token; token: TradeToken }) {
  const { address } = useConnection();
  const { deployment } = useActiveChain();
  const pos = usePositions([pool.id]).data?.[pool.id];
  const ref = useRefPrice(pool.asset, pool.quote).data;
  const names = usePositionNames(pool, A, Q);
  const name = names[token];
  const tx = useTx();
  const [amount, setAmount] = useState("");
  const units = parseAmount(amount, A.decimals);
  const isR = token === "br";
  const held = !pos ? 0n : !isR ? pos.c : pos.r > pos.locked ? pos.r - pos.locked : 0n;
  const per = sellPrice(isR ? "r" : "c", pool.lastClearingPrice, ref, Q.decimals);
  const out = sellOut(units, per, A.decimals);
  const P = name.prefix;
  let label = `Sell ${P} now`;
  let can = false;
  if (per === 0n) label = "No market price yet";
  else if (units === 0n) label = "Enter an amount";
  else if (units > held) label = `Not enough ${P}`;
  else can = true;
  const go = () =>
    deployment &&
    void tx.run(
      [
        {
          label: `Sell ${P}`,
          address: deployment.confluere,
          abi: [],
          functionName: DEMO_SELL_FN[isR ? "r" : "c"],
          args: [pool.id, units, sellMinOut(out)],
          token: { symbol: A.symbol, decimals: A.decimals },
        },
      ],
      { successMessage: `Sold ${fmtToken(units, { symbol: name.symbol, decimals: A.decimals })} for ${fmtToken(out, Q)}. It is in your wallet.`, onSuccess: () => setAmount("") },
    );
  return (
    <div className="space-y-4" data-testid="sell-now">
      <AmountInput
        label="You sell"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        decimals={A.decimals}
        testId="sell-input"
        token={<PositionButton t={token} A={A} name={name} />}
        helper={<span>{isR ? `1 ${P} buys back 1 ${A.symbol}` : `1 ${P} = 1 ${A.symbol} of backing`}</span>}
        balance={address ? <span className="num">You hold {fmtToken(held, { symbol: P, decimals: A.decimals })}</span> : undefined}
        onMax={address && held > 0n ? () => setAmount(toInput(held, A.decimals)) : undefined}
      />
      <DetailRows
        rows={[
          { k: "Market price", v: per > 0n ? `${fmtPer(per, Q)} ${Q.symbol} per ${P}` : "No trades yet" },
          { k: "You receive", v: out > 0n ? `about ${fmtToken(out, Q)}` : "—", testId: "sell-receive" },
          { k: "After the sale", v: <span className="whitespace-normal">{isR ? `You can no longer buy this ${A.symbol} back. The buyer can.` : "You no longer receive the payout at maturity"}</span> },
        ]}
      />
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button variant="primary" size="lg" block disabled={!can || tx.busy} loading={tx.busy} onClick={go} data-testid="sell-button">
          {stageLabel(tx.steps, label)}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} />
    </div>
  );
}

/** Demo only: buy C or R from a sample holder at the sample network's market price. */
function DemoBuy({ pool, A, Q, token }: { pool: PoolRow; A: Token; Q: Token; token: TradeToken }) {
  const { address } = useConnection();
  const { deployment } = useActiveChain();
  const ref = useRefPrice(pool.asset, pool.quote).data;
  const bal = useBalances([Q.address]).data?.[Q.address.toLowerCase()];
  const names = usePositionNames(pool, A, Q);
  const name = names[token];
  const tx = useTx();
  const [amount, setAmount] = useState("");
  const units = parseAmount(amount, A.decimals);
  const isR = token === "br";
  const per = sellPrice(isR ? "r" : "c", pool.lastClearingPrice, ref, Q.decimals);
  const cost = buyCost(units, per, A.decimals);
  const P = name.prefix;
  let label = `Buy ${P} now`;
  let can = false;
  if (per === 0n) label = "No market price yet";
  else if (units === 0n) label = "Enter an amount";
  else if (bal !== undefined && cost > bal) label = `Not enough ${Q.symbol}`;
  else can = true;
  const go = () =>
    deployment &&
    void tx.run(
      [
        {
          label: `Buy ${P}`,
          address: deployment.confluere,
          abi: [],
          functionName: DEMO_BUY_FN[isR ? "r" : "c"],
          args: [pool.id, units, buyMaxIn(cost)],
          token: { symbol: A.symbol, decimals: A.decimals },
        },
      ],
      { successMessage: `Bought ${fmtToken(units, { symbol: name.symbol, decimals: A.decimals })} for ${fmtToken(cost, Q)}.`, onSuccess: () => setAmount("") },
    );
  return (
    <div className="space-y-4" data-testid="buy-now">
      <AmountInput
        label="You receive"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        decimals={A.decimals}
        testId="buy-input"
        token={<PositionButton t={token} A={A} name={name} />}
        helper={<span>{isR ? `1 ${P} buys back 1 ${A.symbol}` : `1 ${P} = 1 ${A.symbol} of backing`}</span>}
        balance={address && bal !== undefined ? <span className="num">Balance {fmtToken(bal, Q)}</span> : undefined}
      />
      <DetailRows
        rows={[
          { k: "Market price", v: per > 0n ? `${fmtPer(per, Q)} ${Q.symbol} per ${P}` : "No trades yet" },
          { k: "You pay", v: cost > 0n ? `about ${fmtToken(cost, Q)}` : "—", testId: "buy-pay" },
          { k: "You get", v: <span className="whitespace-normal">{isR ? `The right to buy ${A.symbol} back at ${fmtPer(buyBack(pool), Q)} ${Q.symbol} until the window ends` : `The payout at maturity: ${fmtPer(buyBack(pool), Q)} ${Q.symbol} if repaid, otherwise 1 ${A.symbol}`}</span> },
        ]}
      />
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button variant="primary" size="lg" block disabled={!can || tx.busy} loading={tx.busy} onClick={go} data-testid="buy-button">
          {stageLabel(tx.steps, label)}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} />
    </div>
  );
}
