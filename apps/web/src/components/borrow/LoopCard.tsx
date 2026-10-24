"use client";

/**
 * Loop (FRONTEND_V3 §8.4, IA v3.1 item 3): repeated borrowing at one maturity in a market that repays any time.
 *
 * - On the network's own coin (WHYPE / WMON against USDC): each round borrows USDC against the coin, the borrower turns
 *   the USDC back into the coin wherever they trade (outside Confluere; we never do it for them) and borrows again. The
 *   coin can be paid as HYPE / MON directly: the wrap is a step of the same button (IA v3.1 item 11).
 * - On a staked token against its own coin (pegged market): the borrower stakes what they receive, outside Confluere.
 *
 * The plan is arithmetic only; progress is read from the chain.
 */
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useConnection } from "wagmi";
import { useActiveChain } from "@/lib/activeChain";
import { useBlockTime, useConvertToShares, type PoolRow, type Token } from "@/lib/data";
import { usePositions } from "@/lib/position";
import { useActionCtx, useChainClock } from "@/lib/useProduct";
import { useRefPrice } from "@/lib/refPrice";
import { defaultStakeRate, loopProgress, planLoop, readLoop, saveLoop, savedToInput, RATE_ONE } from "@/lib/loop";
import { refToUnits } from "@/lib/quote";
import { repayDeadline } from "@/lib/deadline";
import { stakeStep } from "@/lib/tokens";
import { isPegged } from "@/lib/markets";
import { isWrappedNative } from "@/lib/native";
import { usePayWith } from "../common/PayWith";
import { borrowWrites } from "@/lib/actions";
import { useTx } from "@/lib/tx";
import { fmtClock, fmtToken, parseAmount, pct, toInput } from "@/lib/format";
import { buyBack, lastTraded, loopInput, takesOrders } from "@/lib/view";
import { AmountInput, Button, Card, ChipRow, DateTime, DetailRows, OutcomeStrip, StepsLine, TxErrorLine, useLiveNow } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { RoundPill } from "../common/Status";
import { SummaryDetails } from "../common/SummaryDetails";

const SOURCE: Record<string, (lst: string) => string> = {
  lst: (lst) => `From ${lst}'s own rate`,
  reference: () => "From price now",
  pstar: () => "From last traded",
};

/** `embedded`: inside another card (the home card's Loop mode), so no card of its own and no title. */
export function LoopCard({ pool, A, Q, embedded = false, top }: { pool: PoolRow; A: Token; Q: Token; embedded?: boolean; /** Embedded only: shown first when the details open (the home card's Maturity / Pool selectors). */ top?: React.ReactNode }) {
  const { deployment } = useActiveChain();
  const { address } = useConnection();
  const { now: chainNow, block } = useChainClock();
  const live = useLiveNow();
  const now = live || chainNow;
  const ref = useRefPrice(pool.asset, pool.quote).data ?? undefined;
  const [start, setStart] = useState("");
  const [roundsN, setRoundsN] = useState(2);
  // the rate follows its live source until the person types their own
  const [rateStr, setRateStr] = useState<string>();
  const shares = useConvertToShares(pool.asset, 10n ** BigInt(Q.decimals)).data;
  const price = lastTraded(pool) > 0n ? lastTraded(pool) : (refToUnits(ref, Q.decimals) ?? 0n);
  const auto = defaultStakeRate({ sharesPerNative: shares, ref, pStar: price, assetDecimals: A.decimals, quoteDecimals: Q.decimals });
  const autoStr = auto ? toInput(auto.rate, 18).replace(/(\.\d{6})\d+$/, "$1") : "";
  const own = rateStr !== undefined;
  const rate = own ? parseAmount(rateStr, 18) : (auto?.rate ?? 0n);
  const chainId = deployment?.chainId ?? 0;
  const coinMarket = isWrappedNative(chainId, pool.asset);
  const staking = isPegged(pool) && !coinMarket;
  const pw = usePayWith(A, { title: "Start with" });
  const native = pw.native;
  const nat = pw.nat;
  const P = pw.P ?? A;
  const bal = pw.bal;
  const spendable = pw.max;
  const coin = Q.symbol.replace(/^W/, "");
  const r = usePositions([pool.id]).data?.[pool.id]?.r ?? 0n;
  const spb = useBlockTime().data;
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const saved = readLoop(pool.id);
  const [placed, setPlaced] = useState<number>();
  const open = takesOrders(pool, now, block);

  const a0 = parseAmount(start, A.decimals);
  const input = saved && !start ? savedToInput(saved, buyBack(pool), A.decimals, Q.decimals) : loopInput({ a0, price, buyBack: buyBack(pool), rate, rounds: roundsN, assetDecimals: A.decimals, quoteDecimals: Q.decimals });
  const plan = input.a0 > 0n && input.pStar > 0n && input.stakeRate > 0n ? planLoop(input) : undefined;
  const done = plan ? loopProgress(plan, r) : 0;
  const next = plan?.rounds[done];
  const deadline = repayDeadline(pool, { now, block, spb, windowBlocks: deployment?.windowBlocks ?? 0 });
  const stake = staking ? stakeStep(chainId, pool.asset) : undefined;
  const short = !!address && spendable !== undefined && !!next && next.sell > spendable;
  const rateDisplay = rate > 0n ? Number(rate) / Number(RATE_ONE) : 0;

  const go = async () => {
    if (!ctx || !next) return;
    if (done === 0) saveLoop(pool.id, { a0: input.a0.toString(), rounds: input.rounds, pStar: input.pStar.toString(), stakeRate: input.stakeRate.toString() });
    const res = await tx.run(() => borrowWrites(ctx, { pool, units: next.sell, asset: A, slippageBps: 50, payNative: native ? nat.symbol : undefined }), { successMessage: `Loop round ${done + 1} submitted` });
    if (res.ok) setPlaced(done);
  };
  // a submitted round stays locked until it fills (the held repurchase rights grow), so it cannot be sent twice
  const waiting = placed !== undefined && placed === done;

  return (
    <Shell embedded={embedded}>
      {!embedded && <p className="text-body font-medium text-ink">Loop calculator</p>}
      <p className="mt-1 text-body-sm text-ink-2">
        {staking ? (
          <>Borrow {Q.symbol} against {A.symbol}, stake it into {A.symbol} again, repeat.</>
        ) : (
          <>Borrow {Q.symbol} against {P.symbol}, turn it back into {P.symbol}, repeat.</>
        )}{" "}
        Each round is one borrow at the same maturity.
      </p>
      <div className="mt-4 space-y-2">
        <AmountInput
          label="You start with"
          value={saved && !start ? toInput(BigInt(saved.a0), A.decimals) : start}
          onChange={setStart}
          decimals={A.decimals}
          token={pw.button}
          balance={address ? <span className="num">Balance {fmtToken(bal ?? 0n, P)}</span> : undefined}
          onMax={address && spendable ? () => setStart(toInput(spendable, A.decimals)) : undefined}
        />
        {short && stake && (
          <p className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-caption text-warn [overflow-wrap:anywhere]">
            You need {A.symbol}. {stake.href ? <>Stake {deployment ? Q.symbol.replace(/^W/, "") : ""} at {stake.provider} (opens their site).</> : stake.note}
            {stake.href && (
              <a href={stake.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
                Open <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
              </a>
            )}
          </p>
        )}
      </div>
      <div className="mt-4 space-y-2">
        <ChipRow label="Rounds" value={input.rounds} onChange={setRoundsN} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))} />
      </div>
      {embedded ? (
        <>
      <div className="mt-4 space-y-2">
        <TxErrorLine error={tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!open || !next || short || tx.busy || waiting} loading={tx.busy} onClick={() => void go()}>
            {!open ? "This market no longer takes orders" : waiting ? "Waiting for the round to fill" : !plan ? "Enter an amount" : short ? `Not enough ${P.symbol}` : next ? `${native ? `Wrap ${nat.symbol} and start` : "Start"} round ${done + 1}: borrow ${fmtToken(next.borrowed, Q)}` : `Loop round ${plan.rounds.length} of ${plan.rounds.length} done.`}
          </Button>
        </WalletAction>
        <StepsLine steps={tx.steps} />
      </div>
          <div className="mt-4 border-t border-line pt-3">
            <SummaryDetails testId="loop-details" summary={plan ? `${plan.leverage.toFixed(2)}× exposure · repay ${fmtToken(plan.buyBack, Q)} by ${deadline.known ? `≈ ${fmtClock(deadline.ts)}` : `${fmtClock(pool.expiry)} + window`}` : `Rate, rounds and what you repay`}>
              {top && <div className="mb-4">{top}</div>}
      <div className="mt-4">
        <AmountInput
          big={false}
          label="Exchange rate"
          value={own ? rateStr : autoStr}
          onChange={setRateStr}
          token={<span className="text-body-sm text-ink-2">{P.symbol} per 1 {coin}</span>}
          helper={
            <span className="num">
              1 {coin} = {rateDisplay.toLocaleString("en-US", { maximumFractionDigits: 4 })} {P.symbol}
              {auto && !own ? `. ${SOURCE[auto.source]!(A.symbol)}` : ". Your own rate"}
            </span>
          }
        />
      </div>
      {plan && (
        <div className="mt-5 border-t border-line pt-4" data-testid="loop-plan">
          <DetailRows
            rows={[
              { k: "Total exposure", v: `${plan.leverage.toFixed(2)}×`, hint: fmtToken(plan.exposure, A) },
              { k: "Borrowed in total", v: fmtToken(plan.borrowed, Q) },
              { k: "Repay", v: fmtToken(plan.buyBack, Q), hint: deadline.known ? <>by <DateTime ts={deadline.ts} approx /></> : <>by <DateTime ts={pool.expiry} /> + window</> },
              { k: "Borrow cost to maturity", v: fmtToken(plan.cost, Q), hint: pct(plan.borrowed > 0n ? Number(plan.cost) / Number(plan.borrowed) : 0) },
              { k: "Liquidation price", v: "None" },
            ]}
          />
          <p className="mt-3 text-caption text-ink-3">
            {staking
              ? `Net yield ≈ the staking yield of ${A.symbol} minus the borrow cost above.`
              : `You gain if ${P.symbol} rises by more than the borrow cost, and lose more than holding if it falls.`}{" "}
            Repay or roll over at every maturity.
          </p>
        </div>
      )}
      {plan && (
        <div className="mt-4">
          <OutcomeStrip
            left={{ title: "If you repay", body: <>You hold <span className="num">{fmtToken(plan.exposure, A)}</span>.</> }}
            right={{ title: "If you don't", body: <>You keep the <span className="num">{fmtToken(plan.borrowed, Q)}</span>, lenders keep <span className="num">{fmtToken(plan.rUnits, A)}</span>. You still hold <span className="num">{fmtToken(plan.hold, A)}</span>.</> }}
          />
        </div>
      )}
      <ol className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-3" aria-label="Each round">
        <li>1 Borrow {Q.symbol}</li>
        <li>2 Withdraw it from Portfolio</li>
        <li>{staking ? (stake ? `3 Stake at ${stake.provider}${stake.href ? " (their site)" : `: send ${Q.symbol.replace(/^W/, "")} to the ${A.symbol} contract`}` : "3 Stake it (outside Confluere)") : `3 Turn it into ${P.symbol} where you usually trade`}</li>
      </ol>
            </SummaryDetails>
            {plan && <p className="mt-3 text-caption text-ink-3">If you don&apos;t repay: you keep the {Q.symbol}, lenders keep the {A.symbol} you sold. No liquidation.</p>}
          </div>
      <div className="mt-3">
        {!open ? (
          <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-body-sm text-ink-2" data-testid="loop-closed">
            This market has matured and no longer takes orders. Pick an open one from the list.
          </p>
        ) : waiting ? (
          <p className="text-caption text-ink-2" role="status">Round {done + 1} submitted. It fills at the next round; then withdraw and {staking ? "stake" : `turn it into ${P.symbol}`} before starting the next one.</p>
        ) : (
          <RoundPill pool={pool} now={now} block={block} />
        )}
      </div>
      {plan && done > 0 && (
        <p className="mt-3 text-body-sm text-ink-2" data-testid="loop-progress">
          Loop round {done} of {plan.rounds.length} done.
        </p>
      )}
        </>
      ) : (
        <>
      <div className="mt-4">
        <AmountInput
          big={false}
          label="Exchange rate"
          value={own ? rateStr : autoStr}
          onChange={setRateStr}
          token={<span className="text-body-sm text-ink-2">{P.symbol} per 1 {coin}</span>}
          helper={
            <span className="num">
              1 {coin} = {rateDisplay.toLocaleString("en-US", { maximumFractionDigits: 4 })} {P.symbol}
              {auto && !own ? `. ${SOURCE[auto.source]!(A.symbol)}` : ". Your own rate"}
            </span>
          }
        />
      </div>
      {plan && (
        <div className="mt-5 border-t border-line pt-4" data-testid="loop-plan">
          <DetailRows
            rows={[
              { k: "Total exposure", v: `${plan.leverage.toFixed(2)}×`, hint: fmtToken(plan.exposure, A) },
              { k: "Borrowed in total", v: fmtToken(plan.borrowed, Q) },
              { k: "Repay", v: fmtToken(plan.buyBack, Q), hint: deadline.known ? <>by <DateTime ts={deadline.ts} approx /></> : <>by <DateTime ts={pool.expiry} /> + window</> },
              { k: "Borrow cost to maturity", v: fmtToken(plan.cost, Q), hint: pct(plan.borrowed > 0n ? Number(plan.cost) / Number(plan.borrowed) : 0) },
              { k: "Liquidation price", v: "None" },
            ]}
          />
          <p className="mt-3 text-caption text-ink-3">
            {staking
              ? `Net yield ≈ the staking yield of ${A.symbol} minus the borrow cost above.`
              : `You gain if ${P.symbol} rises by more than the borrow cost, and lose more than holding if it falls.`}{" "}
            Repay or roll over at every maturity.
          </p>
        </div>
      )}
      {plan && (
        <div className="mt-4">
          <OutcomeStrip
            left={{ title: "If you repay", body: <>You hold <span className="num">{fmtToken(plan.exposure, A)}</span>.</> }}
            right={{ title: "If you don't", body: <>You keep the <span className="num">{fmtToken(plan.borrowed, Q)}</span>, lenders keep <span className="num">{fmtToken(plan.rUnits, A)}</span>. You still hold <span className="num">{fmtToken(plan.hold, A)}</span>.</> }}
          />
        </div>
      )}
      <ol className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-caption text-ink-3" aria-label="Each round">
        <li>1 Borrow {Q.symbol}</li>
        <li>2 Withdraw it from Portfolio</li>
        <li>{staking ? (stake ? `3 Stake at ${stake.provider}${stake.href ? " (their site)" : `: send ${Q.symbol.replace(/^W/, "")} to the ${A.symbol} contract`}` : "3 Stake it (outside Confluere)") : `3 Turn it into ${P.symbol} where you usually trade`}</li>
      </ol>
      <div className="mt-3">
        {!open ? (
          <p className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-body-sm text-ink-2" data-testid="loop-closed">
            This market has matured and no longer takes orders. Pick an open one from the list.
          </p>
        ) : waiting ? (
          <p className="text-caption text-ink-2" role="status">Round {done + 1} submitted. It fills at the next round; then withdraw and {staking ? "stake" : `turn it into ${P.symbol}`} before starting the next one.</p>
        ) : (
          <RoundPill pool={pool} now={now} block={block} />
        )}
      </div>
      {plan && done > 0 && (
        <p className="mt-3 text-body-sm text-ink-2" data-testid="loop-progress">
          Loop round {done} of {plan.rounds.length} done.
        </p>
      )}
      <div className="mt-4 space-y-2">
        <TxErrorLine error={tx.lastError} />
        <WalletAction>
          <Button variant="primary" size="lg" block disabled={!open || !next || short || tx.busy || waiting} loading={tx.busy} onClick={() => void go()}>
            {!open ? "This market no longer takes orders" : waiting ? "Waiting for the round to fill" : !plan ? "Enter an amount" : short ? `Not enough ${P.symbol}` : next ? `${native ? `Wrap ${nat.symbol} and start` : "Start"} round ${done + 1}: borrow ${fmtToken(next.borrowed, Q)}` : `Loop round ${plan.rounds.length} of ${plan.rounds.length} done.`}
          </Button>
        </WalletAction>
        <StepsLine steps={tx.steps} />
      </div>
        </>
      )}
      {pw.picker}
    </Shell>
  );
}

const Shell = ({ embedded, children }: { embedded: boolean; children: React.ReactNode }) =>
  embedded ? (
    <div data-testid="loop-card">{children}</div>
  ) : (
    <Card className="p-4 sm:p-5" data-testid="loop-card">
      {children}
    </Card>
  );
