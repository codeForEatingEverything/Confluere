"use client";

/**
 * Portfolio actions (FRONTEND_V3 §8.5.1–8.5.3): Repay, Roll over to the next maturity, Collect (payout or auction surplus), Collect all, Wrap as ERC-20.
 * Each is a modal or a drawer over the Portfolio page; nothing navigates away.
 */
import { useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { useDemoClientOr } from "@/lib/demo/hooks";
import { zeroAddress, type Address } from "viem";
import { cTokenId, erc6909WrapperAbi, erc6909WrapperFactoryAbi, rTokenId, repayAmount, routerAbi } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, useBlockTime, usePools, useTokens, useWrapper, type PoolRow, type Token } from "@/lib/data";
import { positionName } from "@/lib/vocab";
import { useBalances, useIsOperator } from "@/lib/position";
import { useActionCtx, useChainClock } from "@/lib/useProduct";
import { claimWrite, repayWrites, rolloverPlan, rolloverWrites } from "@/lib/actions";
import { defaultRolloverTarget, rolloverTargets } from "@/lib/rollover";
import { repayDeadline } from "@/lib/deadline";
import { useAllowance } from "@/lib/allowance";
import { fmtChip, fmtPer, fmtToken, fmtWeekday, parseAmount, toInput } from "@/lib/format";
import { buyBack, lastTraded, unitScale } from "@/lib/view";
import { useTx, type Write } from "@/lib/tx";
import type { BorrowPosition, LendPosition } from "@/lib/product";
import { AmountInput, Address as Addr, Button, ChipRow, DateTime, Disclosure, Drawer, Modal, OutcomeStrip, PositionIcon, Segmented, StepsLine, TokenButton, TxErrorLine, stageLabel } from "../ui";
import { TokenShortfall } from "../common/TokenShortfall";
import { WalletAction } from "../layout/WalletMenu";

const close = (onClose: () => void) => ({ onSuccess: onClose });

/** Repay: buy the tokens back at the buy-back price (part or all). */
export function RepayModal({ loan, asset, quote, onClose }: { loan?: BorrowPosition; asset?: Token; quote?: Token; onClose: () => void }) {
  return (
    <Modal open={!!loan} onClose={onClose} title="Repay" testId="repay-modal">
      {loan && asset && quote && <RepayBody loan={loan} asset={asset} quote={quote} onClose={onClose} />}
    </Modal>
  );
}

function RepayBody({ loan, asset, quote, onClose }: { loan: BorrowPosition; asset: Token; quote: Token; onClose: () => void }) {
  const { deployment } = useActiveChain();
  const [amount, setAmount] = useState(toInput(loan.free, asset.decimals));
  const units = parseAmount(amount, asset.decimals);
  const pay = repayAmount(units, buyBack(loan.pool), unitScale(loan.pool));
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const allowance = useAllowance(loan.pool.quote).data;
  const bal = useBalances([loan.pool.quote]).data?.[loan.pool.quote.toLowerCase()];
  const { now, block } = useChainClock();
  const spb = useBlockTime().data;
  const d = repayDeadline(loan.pool, { now, block, spb, windowBlocks: deployment?.windowBlocks ?? 0 });
  const tooMuch = units > loan.free;
  const short = bal !== undefined && pay > bal;
  const needsApprove = allowance !== undefined && allowance < pay;
  const affordable = bal !== undefined && buyBack(loan.pool) > 0n ? (bal * unitScale(loan.pool)) / buyBack(loan.pool) : 0n;
  return (
    <div className="space-y-4">
      <AmountInput
        label="Collateral to buy back"
        value={amount}
        onChange={(v) => {
          setAmount(v);
          tx.reset();
        }}
        readOnly={tx.busy}
        decimals={asset.decimals}
        token={<TokenButton symbol={asset.symbol} address={asset.address} />}
        balance={<span className="num">Your loan {fmtToken(loan.free, asset)}</span>}
        onMax={() => setAmount(toInput(loan.free, asset.decimals))}
        error={tooMuch ? "More than your loan" : undefined}
      />
      <div className="well space-y-2 px-4 py-3 text-body-sm">
        <p className="flex justify-between gap-3">
          <span className="text-ink-2">You pay</span> <strong className="num font-semibold">{fmtToken(pay, quote)}</strong>
        </p>
        <p className="flex justify-between gap-3">
          <span className="text-ink-2">You get back</span> <strong className="num font-semibold">{fmtToken(units, asset)}</strong>
        </p>
        <p className="flex justify-between gap-3">
          <span className="text-ink-2">Wallet balance</span> <span className="num">{fmtToken(bal ?? 0n, quote)}</span>
        </p>
      </div>
      {short && <TokenShortfall token={quote} need={pay} />}
      {short && affordable > 0n && affordable < loan.free && (
        <button type="button" className="link text-body-sm" onClick={() => setAmount(toInput(affordable, asset.decimals))}>
          Repay what you can: {fmtToken(affordable, asset)}
        </button>
      )}
      <p className="text-body-sm text-ink-2">
        Repay by {d.known ? <DateTime ts={d.ts} approx /> : <DateTime ts={loan.pool.expiry} />}. After that the position closes and lenders keep the {asset.symbol}.
      </p>
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button
          variant="primary"
          size="lg"
          block
          disabled={units === 0n || tooMuch || short || !loan.canRepay || tx.busy}
          loading={tx.busy}
          onClick={() => ctx && void tx.run(() => repayWrites(ctx, { pool: loan.pool, units, quote }), { onSuccess: onClose, successMessage: `Repaid ${fmtToken(pay, quote)}. ${fmtToken(units, asset)} is back in your wallet.` })}
          data-testid="repay-button"
        >
          {stageLabel(tx.steps, units === 0n ? "Enter an amount" : tooMuch ? "More than your position" : short ? `Not enough ${quote.symbol}` : !loan.canRepay ? "Repayment opens at maturity" : `Repay ${fmtToken(pay, quote)}`)}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} labels={needsApprove && units > 0n ? [`Approve ${quote.symbol}`, "Repay"] : undefined} />
    </div>
  );
}

/** Roll over: the collateral stays in the contract and is sold again into a later maturity; that sale pays this one. */
export function ExtendDrawer({ loan, asset, quote, onClose }: { loan?: BorrowPosition; asset?: Token; quote?: Token; onClose: () => void }) {
  return (
    <Drawer open={!!loan} onClose={onClose} title="Roll over to the next maturity" testId="extend-drawer">
      {loan && asset && quote && <ExtendBody loan={loan} asset={asset} quote={quote} onClose={onClose} />}
    </Drawer>
  );
}

function ExtendBody({ loan, asset, quote, onClose }: { loan: BorrowPosition; asset: Token; quote: Token; onClose: () => void }) {
  const { deployment } = useActiveChain();
  const pools = usePools().data ?? [];
  const targets = useMemo(() => rolloverTargets(loan.pool, pools).slice(0, 6), [loan.pool, pools]);
  const def = defaultRolloverTarget(loan.pool, pools);
  const [toId, setTo] = useState<string | undefined>(def?.id);
  const to = targets.find((p) => p.id === toId) ?? def;
  const [amount, setAmount] = useState(toInput(loan.free, asset.decimals));
  const [minStr, setMin] = useState("");
  const units = parseAmount(amount, asset.decimals);
  const { now } = useChainClock();
  const spb = useBlockTime().data;
  const tx = useTx();
  const ctx = useActionCtx(tx);
  if (!to)
    return <p className="text-body-sm text-ink-2">No later maturity of this market is open right now. You can still repay before the deadline.</p>;
  const minPrice = minStr ? parseAmount(minStr, quote.decimals) : undefined;
  const plan = rolloverPlan({ from: loan.pool, to, units, now, spb, minPrice }, deployment?.windowBlocks ?? 0);
  const noPrice = plan.minPrice === 0n;
  return (
    <div className="space-y-4">
      <ChipRow
        label="Roll over to"
        value={to.id}
        onChange={setTo}
        options={targets.map((p) => ({ value: p.id, label: `${fmtChip(p.expiry)}, repay ${fmtPer(buyBack(p), quote)}` }))}
      />
      <AmountInput
        label="Collateral to roll over"
        value={amount}
        onChange={setAmount}
        decimals={asset.decimals}
        token={<TokenButton symbol={asset.symbol} address={asset.address} />}
        balance={<span className="num">Position {fmtToken(loan.free, asset)}</span>}
        onMax={() => setAmount(toInput(loan.free, asset.decimals))}
        error={units > loan.free ? "More than your position" : undefined}
      />
      <p className="text-body-sm leading-6">
        Your <span className="num">{fmtToken(units, asset)}</span> stays in the contract and is sold again into the {fmtWeekday(to.expiry)} maturity at market price. The proceeds pay this maturity&apos;s{" "}
        <span className="num">{fmtToken(repayAmount(units, buyBack(loan.pool), unitScale(loan.pool)), quote)}</span>.
      </p>
      <div className="well px-4 py-3">
        <p className="text-caption text-ink-2">
          You may need up to <strong className="num text-body-sm text-ink">{fmtToken(plan.maxTopUp, quote)}</strong> extra
        </p>
        <p className="mt-1 text-caption text-ink-3">The unused part returns to Ready to withdraw.</p>
      </div>
      <OutcomeStrip
        left={{ title: "If it fills", body: <>Your position continues to {fmtWeekday(to.expiry)} at the new price.</> }}
        right={{ title: "If it doesn't fill", body: <>Nothing changes: repay {fmtToken(repayAmount(units, buyBack(loan.pool), unitScale(loan.pool)), quote)} by the current deadline to get your {asset.symbol} back, otherwise lenders keep it.</> }}
      />
      <Disclosure title="Order settings" open={noPrice || undefined}>
        <div className="space-y-2">
          <AmountInput big={false} label="Minimum sale price" value={minStr || (plan.minPrice > 0n ? toInput(plan.minPrice, quote.decimals) : "")} onChange={setMin} decimals={quote.decimals} token={<TokenButton symbol={quote.symbol} />} helper={`per ${asset.symbol}`} />
          <p className="text-caption text-ink-3">Keeps trying until this maturity&apos;s repayment window ends{plan.tries ? `, about ${plan.tries} rounds` : ""}.</p>
          {lastTraded(to) === 0n && <p className="text-caption text-ink-3">The later maturity has not traded yet, so set the minimum price yourself.</p>}
        </div>
      </Disclosure>
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button
          variant="primary"
          size="lg"
          block
          disabled={units === 0n || units > loan.free || noPrice || !loan.canRollover || tx.busy}
          loading={tx.busy}
          onClick={() => ctx && void tx.run(() => rolloverWrites(ctx, { from: loan.pool, to, units, quote, now, spb, minPrice }), { onSuccess: onClose, successMessage: `Roll-over to ${fmtWeekday(to.expiry)} submitted.` })}
          data-testid="extend-button"
        >
          {stageLabel(tx.steps, !loan.canRollover ? "Can't roll over after the repayment window" : units === 0n ? "Enter an amount" : units > loan.free ? "More than your position" : noPrice ? "Set a minimum sale price" : `Roll over to ${fmtWeekday(to.expiry)}`)}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} />
    </div>
  );
}

/** Collect from one closed pool: a lender's payout (quote and any collateral), or a borrower's auction surplus. */
export function ClaimModal({ pool, lines, kind = "payout", onClose }: { pool?: PoolRow; lines: string[]; kind?: "payout" | "surplus"; onClose: () => void }) {
  const tx = useTx();
  const ctx = useActionCtx(tx);
  return (
    <Modal open={!!pool} onClose={onClose} title={kind === "payout" ? "Collect your payout" : "Collect auction surplus"} testId="claim-modal">
      {pool && (
        <div className="space-y-4">
          <div className="well space-y-1 px-4 py-3">
            {lines.map((l) => (
              <p key={l} className="num text-title font-semibold">
                {l}
              </p>
            ))}
          </div>
          <p className="text-body-sm text-ink-2">
            {kind === "payout" ? "Repaid loans pay out in the loan token, unrepaid ones in collateral. " : ""}Goes straight to your wallet.
          </p>
          <TxErrorLine error={tx.lastError} />
          <WalletAction>
            <Button variant="primary" size="lg" block loading={tx.busy} onClick={() => ctx && void tx.run([claimWrite(ctx, pool)], { successMessage: "Collected to your wallet.", onSuccess: onClose })}>
              Collect
            </Button>
          </WalletAction>
        </div>
      )}
    </Modal>
  );
}

/** Collect from every closed pool in one go through the Router (one-time permission, then one transaction). */
export function ClaimAllButton({ ids, label = "Collect all" }: { ids: `0x${string}`[]; label?: string }) {
  const { deployment } = useActiveChain();
  const tx = useTx();
  const router = deployment?.router;
  return (
    <Button
      size="sm"
      variant="primary"
      loading={tx.busy}
      disabled={!router}
      onClick={() =>
        void tx.run(
          async () => {
            const allow = await tx.ensureOperator(router!, "Allow collecting all at once");
            const w: Write = { label: "Collect all", address: router!, abi: routerAbi, functionName: "claimMany", args: [ids] };
            return [allow, w].filter((x): x is Write => !!x);
          },
          { successMessage: "Collected to your wallet." },
        )
      }
    >
      {label}
    </Button>
  );
}

/** Lending (or a loan) as a plain ERC-20 token, 1:1, tradable anywhere; unwrap to collect or repay. */
export function WrapModal({ target, onClose }: { target?: { pool: PoolRow; which: "lend" | "loan"; held: bigint; asset: Token }; onClose: () => void }) {
  return (
    <Modal open={!!target} onClose={onClose} title="Wrap as ERC-20" testId="wrap-modal">
      {target && <WrapBody {...target} onClose={onClose} />}
    </Modal>
  );
}

function WrapBody({ pool, which, held, asset }: { pool: PoolRow; which: "lend" | "loan"; held: bigint; asset: Token; onClose: () => void }) {
  const { deployment } = useActiveChain();
  const id = which === "lend" ? cTokenId(pool.id) : rTokenId(pool.id);
  const { data: wrapper, refetch } = useWrapper(id);
  const exists = !!wrapper && wrapper !== zeroAddress;
  const isOp = useIsOperator(exists ? wrapper : undefined).data ?? false;
  const wrapped = useBalances(exists ? [wrapper!] : []).data?.[wrapper?.toLowerCase() ?? ""] ?? 0n;
  const [mode, setMode] = useState<"wrap" | "unwrap">("wrap");
  const [amt, setAmt] = useState("");
  const tx = useTx();
  const client = useDemoClientOr(usePublicClient(), useActiveChain().chainId);
  const a = parseAmount(amt, asset.decimals);
  const max = mode === "wrap" ? held : wrapped;
  const f = deployment?.wrapperFactory;
  const what = which === "lend" ? "lending" : "loan";
  const pools = usePools().data;
  const quote = useTokens([pool.quote]).data;
  const Q = tokenOf(quote, pool.quote);
  const t = which === "lend" ? "ft" : "br";
  const name = Q ? positionName(t, pool, asset, Q, { all: pools ?? [] }) : undefined;
  async function go() {
    let w: Address | undefined = exists ? wrapper : undefined;
    if (!w) {
      const r = await tx.run([{ label: "Create the token", address: f!, abi: erc6909WrapperFactoryAbi, functionName: "create", args: [id] }]);
      if (!r.ok) return;
      w = (await client!.readContract({ address: f!, abi: erc6909WrapperFactoryAbi, functionName: "wrapperOf", args: [id] })) as Address;
      await refetch();
    }
    if (mode === "unwrap") {
      await tx.run([{ label: "Unwrap", address: w, abi: erc6909WrapperAbi, functionName: "unwrap", args: [a, tx.account!] }], { onSuccess: () => setAmt("") });
      return;
    }
    await tx.run(
      async () => {
        const allow = await tx.ensureOperator(w!, "Allow the token contract");
        const wrap: Write = { label: "Wrap", address: w!, abi: erc6909WrapperAbi, functionName: "wrap", args: [a, tx.account!] };
        return [allow, wrap].filter((x): x is Write => !!x);
      },
      { onSuccess: () => setAmt("") },
    );
  }
  return (
    <div className="space-y-4 text-body-sm">
      <p className="text-ink-2">Turns your {what} into an ERC-20 token, one for one, that you can hold or trade anywhere. Unwrap it to collect or repay.</p>
      {exists && (
        <p className="flex items-center gap-2">
          <span className="text-ink-2">Token</span> <Addr address={wrapper!} />
        </p>
      )}
      <Segmented
        label="Direction"
        value={mode}
        onChange={setMode}
        options={[
          { value: "wrap", label: "Wrap" },
          { value: "unwrap", label: "Unwrap", disabled: !exists },
        ]}
      />
      <AmountInput
        label="Amount"
        value={amt}
        onChange={setAmt}
        decimals={asset.decimals}
        token={
          <span className="inline-flex items-center gap-2 text-body-sm text-ink-2" title={name?.symbol}>
            <PositionIcon t={t} asset={asset} size={20} />
            {name?.short ?? `${asset.symbol} ${what}`}
          </span>
        }
        balance={<span className="num">Available {fmtToken(max, asset)}</span>}
        onMax={() => setAmt(toInput(max, asset.decimals))}
        error={a > max ? "More than you hold" : undefined}
      />
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button variant="primary" size="lg" block disabled={a === 0n || a > max || tx.busy || !f} loading={tx.busy} onClick={() => void go()}>
          {mode === "wrap" ? "Wrap" : "Unwrap"}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} labels={mode === "wrap" ? [...(exists ? [] : ["Create the token"]), ...(exists && isOp ? [] : ["Allow the token contract"]), "Wrap"] : undefined} />
    </div>
  );
}

export type { LendPosition };
