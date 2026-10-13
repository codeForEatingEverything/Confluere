"use client";

/**
 * Home card, Repay mode (IA v3.1 item 1): You pay = the quote token, You receive = your collateral back. The card finds
 * the pools where the connected wallet holds buy-back rights and buys back at the fixed buy-back price, part or all.
 * Either field can be typed; the other follows (the contract takes a number of collateral units).
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useConnection } from "wagmi";
import { repayAmount } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, useBlockTime, type Token } from "@/lib/data";
import { useActionCtx, useChainClock, usePortfolio } from "@/lib/useProduct";
import { repayWrites } from "@/lib/actions";
import { repayDeadline } from "@/lib/deadline";
import { useAllowance } from "@/lib/allowance";
import { fmtChip, fmtClock, fmtPer, fmtToken, fmtWait, parseAmount, toInput } from "@/lib/format";
import { buyBack, repaysAnyTime, unitScale } from "@/lib/view";
import { useTx } from "@/lib/tx";
import type { BorrowPosition } from "@/lib/product";
import { AmountInput, Button, DateTime, DetailRows, EmptyState, StepsLine, TokenButton, TxErrorLine, stageLabel } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { TokenShortfall } from "../common/TokenShortfall";
import { usePayWith } from "../common/PayWith";
import { SummaryDetails } from "../common/SummaryDetails";
import { reviewSteps } from "../borrow/borrowFlow";
import { SwapArrow, SwapSkeleton } from "./BorrowSwap";
import { SelectField } from "./RouteSelectors";

/** Loans that can still be bought back (window not over), soonest deadline first. */
export const repayableLoans = (borrows: BorrowPosition[]) => borrows.filter((b) => b.free > 0n && !b.lapsed);

export function RepaySwap() {
  const { isConnected } = useConnection();
  const pf = usePortfolio();
  const loans = useMemo(() => repayableLoans(pf.borrows), [pf.borrows]);
  const [pick, setPick] = useState<string>();
  const loan = loans.find((b) => b.pool.id === pick) ?? loans.find((b) => b.canRepay) ?? loans[0];

  if (!isConnected)
    return (
      <div data-testid="repay-swap">
        <div className="pointer-events-none opacity-60" aria-hidden>
          <AmountInput label="You pay" value="" readOnly token={<TokenButton symbol="USDC" />} />
          <SwapArrow />
          <AmountInput label="You receive" value="" readOnly token={<TokenButton symbol="Collateral" />} />
        </div>
        <p className="mt-4 text-body-sm text-ink-2">Connect a wallet to find your loans and buy your collateral back.</p>
        <div className="mt-4">
          <WalletAction>
            <span />
          </WalletAction>
        </div>
      </div>
    );
  if (pf.isLoading && loans.length === 0) return <SwapSkeleton />;
  if (!loan)
    return (
      <div data-testid="repay-swap">
        <EmptyState
          title="No loan to repay on this network"
          body={pf.borrows.length > 0 ? "Your loans here have closed; see Portfolio for anything left to collect." : "When you borrow, your loan appears here until you repay it."}
          actions={
            <Link href="/portfolio" className="link text-body-sm">
              Open Portfolio
            </Link>
          }
        />
      </div>
    );
  const A = tokenOf(pf.tokens, loan.pool.asset);
  const Q = tokenOf(pf.tokens, loan.pool.quote);
  if (!A || !Q) return <SwapSkeleton />;
  return (
    <div data-testid="repay-swap">
      <RepayForm
        key={loan.pool.id}
        loan={loan}
        A={A}
        Q={Q}
        select={
          loans.length > 1 ? (
            <SelectField
              label="Loan"
              title="Choose a loan"
              value={loan.pool.id}
              onChange={(v) => setPick(v)}
              testId="loan-select"
              display={`${fmtToken(loan.free, A)}, matures ${fmtChip(loan.pool.expiry)} UTC`}
              options={loans.map((b) => ({
                value: b.pool.id,
                label: `${fmtToken(b.free, tokenOf(pf.tokens, b.pool.asset))}, matures ${fmtChip(b.pool.expiry)} UTC`,
                aside: b.canRepay ? "Repay now" : "Not yet",
                testId: "loan-chip",
              }))}
            />
          ) : undefined
        }
      />
    </div>
  );
}

function RepayForm({ loan, A, Q, select }: { loan: BorrowPosition; A: Token; Q: Token; /** The loan selector, shown under the amounts like the Borrow card's selectors. */ select?: React.ReactNode }) {
  const { deployment } = useActiveChain();
  const { now, block } = useChainClock();
  const spb = useBlockTime().data;
  const [field, setField] = useState<"pay" | "receive">("receive");
  const [text, setText] = useState(toInput(loan.free, A.decimals));
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const scale = unitScale(loan.pool);
  const k = buyBack(loan.pool);
  const units = field === "receive" ? parseAmount(text, A.decimals) : k > 0n ? (parseAmount(text, Q.decimals) * scale) / k : 0n;
  const pay = repayAmount(units, k, scale);
  const pw = usePayWith(Q);
  // collateral that is WHYPE / WMON can come back as the coin (HYPE / MON): the repay is followed by an unwrap
  const rw = usePayWith(A, { title: "Receive as", preferNative: false });
  const bal = pw.bal;
  const P = pw.P ?? Q;
  const allowance = useAllowance(Q.address).data;
  const d = repayDeadline(loan.pool, { now, block, spb, windowBlocks: deployment?.windowBlocks ?? 0 });
  const [done, setDone] = useState<string>();
  useEffect(() => setDone(undefined), [text]);

  const tooMuch = units > loan.free;
  const short = pw.max !== undefined && pay > pw.max;
  const needsApprove = allowance !== undefined && pay > 0n && allowance < pay;
  let label: string;
  let can = false;
  if (!loan.canRepay) label = repaysAnyTime(loan.pool) ? "Repayment is paused" : `Repay from ${fmtChip(loan.pool.expiry)} UTC`;
  else if (units === 0n) label = "Enter an amount";
  else if (tooMuch) label = "More than your loan";
  else if (short) label = `Not enough ${P.symbol}`;
  else if (pw.native) {
    label = `Wrap ${P.symbol} and repay`;
    can = true;
  } else if (needsApprove) {
    label = `Approve ${Q.symbol}`;
    can = true;
  } else {
    label = `Repay ${fmtToken(pay, Q)}`;
    can = true;
  }
  const left = Math.max(0, (d.known ? d.ts : loan.pool.expiry) - now);
  const go = async () => {
    if (!ctx) return;
    const got = fmtToken(units, rw.P ?? A);
    const r = await tx.run(() => repayWrites(ctx, { pool: loan.pool, units, quote: Q, payNative: pw.nativeSymbol, receiveNative: rw.nativeSymbol }), { successMessage: `Repaid. ${got} is back in your wallet.` });
    if (r.ok) setDone(got);
  };

  return (
    <div>
      <AmountInput
        label="You pay"
        value={field === "pay" ? text : pay > 0n ? toInput(pay, Q.decimals) : ""}
        onChange={(v) => {
          setField("pay");
          setText(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        decimals={Q.decimals}
        testId="repay-pay"
        token={pw.button}
        balance={<span className="num">Balance {fmtToken(bal ?? 0n, P)}</span>}
      />
      {pw.picker}
      <SwapArrow />
      <AmountInput
        label="You receive"
        value={field === "receive" ? text : units > 0n ? toInput(units, A.decimals) : ""}
        onChange={(v) => {
          setField("receive");
          setText(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        decimals={A.decimals}
        testId="repay-receive"
        token={rw.button}
        error={tooMuch ? `Your loan is ${fmtToken(loan.free, A)}` : undefined}
        balance={<span className="num">Loan {fmtToken(loan.free, A)}</span>}
        onMax={() => {
          setField("receive");
          setText(toInput(loan.free, A.decimals));
        }}
      />
      {rw.picker}
      {select && <div className="mt-3">{select}</div>}
      {short && loan.canRepay && (
        <div className="mt-2">
          <TokenShortfall token={Q} need={pay} onUseNative={pw.can && !pw.native ? () => pw.setNative(true) : undefined} />
        </div>
      )}
      <div className="mt-4 space-y-2">
        <TxErrorLine error={tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!can || tx.busy} loading={tx.busy} onClick={() => void go()} data-testid="repay-button">
            {stageLabel(tx.steps, label)}
          </Button>
        </WalletAction>
        <StepsLine steps={tx.steps} labels={can ? (() => { const s = reviewSteps({ payNative: pw.native, needsApprove, payToken: P }, Q.symbol, "Repay") ?? ["Repay"]; return rw.native ? [...s, `Unwrap to ${rw.nat.symbol}`] : s.length > 1 ? s : undefined; })() : undefined} />
      </div>
      {done && (
        <p className="mt-4 rounded-[var(--radius-control)] bg-good-soft px-3 py-2 text-body-sm text-good" role="status">
          Repaid. {done} is back in your wallet.
        </p>
      )}
      <div className="mt-3" data-testid="repay-terms">
        <SummaryDetails testId="repay-terms" summary={`Pay ${fmtToken(pay > 0n ? pay : repayAmount(10n ** BigInt(A.decimals), k, scale), Q)}${units > 0n ? "" : ` per ${A.symbol}`} · repay by ${d.known ? `≈ ${fmtClock(d.ts)}` : `${fmtClock(loan.pool.expiry)} + window`}${left > 0 ? ` (in ${fmtWait(left)})` : ""}`}>
          <DetailRows
            rows={[
              { k: "Buy-back price", v: `${fmtPer(k, Q)} ${Q.symbol}`, hint: `per 1 ${A.symbol}, fixed when you borrowed` },
              { k: "Repay by", v: d.known ? <DateTime ts={d.ts} approx /> : <><DateTime ts={loan.pool.expiry} /> + repayment window</>, hint: left > 0 ? `in ${fmtWait(left)}` : undefined },
              { k: "Left on the loan after this", v: fmtToken(loan.free > units ? loan.free - units : 0n, A) },
              { k: "Fee", v: "None", hint: "the protocol's share comes out of the lenders' interest" },
            ]}
          />
          <p className="mt-3 text-caption text-ink-3">After the deadline the loan closes: you keep what you borrowed and lenders keep the {A.symbol}.</p>
        </SummaryDetails>
      </div>
    </div>
  );
}
