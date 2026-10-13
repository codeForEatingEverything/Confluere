"use client";

/**
 * The LP action card (IA v3.1 item 8; Pendle pool "zap" card). Three tabs:
 *
 * - Zap in: what you put in as prepaid tax and your own price; shows the LP token you get (cLP-asset-quote, balance =
 *   prepaid tax + bond) and what you pay: the current LP's price (free while nobody holds it), the bond and the prepaid
 *   tax. One button: approve the loan token if needed, then take the slot.
 * - Manage: this round's order (the LP's duty), top up the prepaid tax, change your price (no lowering for 7 days after
 *   you took the slot), collect earnings.
 * - Zap out: leave the slot and get the prepaid tax left and the bond back, with any earnings, in one flow.
 *
 * Under the card, the mechanism in a few plain sentences (a Harberger tax, without the name).
 */
import { useState } from "react";
import { useConnection } from "wagmi";
import { useActiveChain } from "@/lib/activeChain";
import type { Token } from "@/lib/data";
import type { Market } from "@/lib/markets";
import { useAllowance } from "@/lib/allowance";
import { holderUnsplitShare, isVacant, useRegistryParams, useSeat, type SeatView } from "@/lib/seats";
import { exitReturn, isMine, lpSymbol, lpTokenOf, priceLocked, useAddLpToWallet, zapInQuote } from "@/lib/lp";
import { seatBuyWrite, seatPriceWrite, seatReleaseWrite, seatSplitWrite, seatTopUpWrite, seatWithdrawWrite } from "@/lib/proActions";
import { useChainClock } from "@/lib/useProduct";
import { fmtExpiry, fmtToken, fmtWait, parseAmount, short, toInput } from "@/lib/format";
import { usePayWith } from "../common/PayWith";
import { useActiveChainId } from "@/lib/activeChain";
import { withWrap } from "@/lib/native";
import { useTx, type Write } from "@/lib/tx";
import { AmountInput, Button, Card, DetailRows, Segmented, Skeleton, StepsLine, TokenButton, TxErrorLine, stageLabel, useLiveNow } from "../ui";
import { WalletAction } from "../layout/WalletMenu";
import { LpIcon } from "./LpIcon";
import { LpOrderForm } from "./LpOrderForm";

type Tab = "in" | "manage" | "out";

export function ZapCard({ m, A, Q }: { m: Market; A: Token; Q: Token }) {
  const { address } = useConnection();
  const { deployment } = useActiveChain();
  const seat = useSeat(m).data;
  const params = useRegistryParams().data;
  const mine = isMine(seat, address);
  const [tabSel, setTab] = useState<Tab>();
  const tab: Tab = tabSel ?? (mine ? "manage" : "in");
  const reg = deployment?.seatRegistry;
  const sym = lpSymbol(A, Q);

  return (
    <div className="space-y-3">
      <Card className="p-4 sm:p-5" data-testid="zap-card">
        <Segmented
          label="LP action"
          value={tab}
          onChange={setTab}
          className="w-full [&>button]:flex-1"
          options={[
            { value: "in", label: "Zap in", testId: "zap-in-tab" },
            { value: "manage", label: "Manage", testId: "zap-manage-tab" },
            { value: "out", label: "Zap out", testId: "zap-out-tab" },
          ]}
        />
        <div className="mt-4">
          {!seat || !params || !reg ? (
            <Skeleton className="h-60 w-full" label="Loading LP slot" />
          ) : seat.obligation === 0n ? (
            <p className="text-body-sm text-ink-2">Markets that lend {Q.symbol} have no LP slot.</p>
          ) : (
            <>
              {mine && <LpPosition m={m} A={A} Q={Q} seat={seat} sym={sym} />}
              {tab === "in" ? (
                <ZapIn m={m} A={A} Q={Q} seat={seat} taxBps={params.tax} registry={reg} mine={mine} sym={sym} />
              ) : tab === "manage" ? (
                <Manage m={m} A={A} Q={Q} seat={seat} registry={reg} mine={mine} account={address} />
              ) : (
                <ZapOut m={m} Q={Q} seat={seat} registry={reg} mine={mine} account={address} />
              )}
            </>
          )}
        </div>
      </Card>
      <p className="px-1 text-caption text-ink-2" data-testid="lp-explainer">
        The LP slot works like a lease you price yourself. You name a price and pay {params ? `${params.tax / 100}%` : "a share"} of it per year as tax, taken every second from your prepaid tax. Anyone can take the slot over at any time by paying you that price, so a high price keeps it safe but costs more tax. While you hold it you keep an order in every round and earn {params ? `${params.share / 100}%` : "a share"} of the market&apos;s protocol income; you can leave whenever you like and get the rest back.
      </p>
    </div>
  );
}

/** The LP token you hold: stacked pair icon, cLP symbol, balance, and Add to wallet. */
function LpPosition({ m, A, Q, seat, sym }: { m: Market; A: Token; Q: Token; seat: SeatView; sym: string }) {
  const { deployment } = useActiveChain();
  const token = lpTokenOf(deployment, m);
  const add = useAddLpToWallet();
  return (
    <div className="well mb-4 flex flex-wrap items-center gap-3 px-4 py-3" data-testid="lp-position">
      <LpIcon asset={A} quote={Q} size={24} />
      <span className="min-w-0 flex-1">
        <span className="block text-caption text-ink-2">Your LP token</span>
        <span className="num block text-body font-semibold text-ink">
          {fmtToken(exitReturn(seat), Q, false)} {sym}
        </span>
      </span>
      {token && (
        <Button size="sm" variant="secondary" loading={add.pending} onClick={() => add.add({ token, asset: A.onchainSymbol ?? A.symbol, quote: Q.onchainSymbol ?? Q.symbol, assetAddress: A.address, quoteAddress: Q.address, decimals: Q.decimals })}>
          {add.added ? "Added" : "Add to wallet"}
        </Button>
      )}
    </div>
  );
}

function ZapIn({ m, A, Q, seat, taxBps, registry, mine, sym }: { m: Market; A: Token; Q: Token; seat: SeatView; taxBps: number; registry: `0x${string}`; mine: boolean; sym: string }) {
  const { address } = useConnection();
  const tx = useTx();
  const [deposit, setDeposit] = useState("");
  const [price, setPrice] = useState("");
  const d = parseAmount(deposit, Q.decimals);
  const p = parseAmount(price, Q.decimals);
  const z = zapInQuote(seat, p, d, taxBps);
  // IA v3.1 item 11: when the market lends WHYPE / WMON the LP can pay in HYPE / MON; the wrap is the first step
  const pw = usePayWith(Q);
  const chainId = useActiveChainId();
  const P = pw.P ?? Q;
  const bal = pw.max;
  const allowance = useAllowance(Q.address, registry).data;
  const vacant = isVacant(seat);
  const needsApprove = !!address && (pw.native || (allowance !== undefined && z.total > 0n && allowance < z.total));
  const days = Number.isFinite(z.lasts) ? z.lasts / 86_400 : undefined;

  let label: string;
  let can = false;
  if (mine) label = "You are the LP";
  else if (p === 0n) label = "Enter your price";
  else if (d === 0n) label = "Enter an amount";
  else if (address && bal !== undefined && z.total > bal) label = `Not enough ${P.symbol}`;
  else {
    label = pw.native ? `Wrap ${P.symbol} and zap in` : needsApprove ? `Approve ${Q.symbol} and zap in` : "Zap in";
    can = true;
  }
  const go = () =>
    void tx.run(
      async () => {
        const a = await tx.ensureAllowance(Q.address, z.total, registry, { symbol: Q.symbol });
        const w = [a, { ...seatBuyWrite(registry, m, p, d, z.toHolder, Q), label: "Zap in" }].filter((x): x is Write => !!x);
        return pw.native ? withWrap(chainId, z.total, w) : w;
      },
      { successMessage: `You are now the ${A.symbol} / ${Q.symbol} LP.`, onSuccess: () => (setDeposit(""), setPrice("")) },
    );

  return (
    <div className="space-y-3" data-testid="zap-in">
      <AmountInput
        label="You put in"
        value={deposit}
        onChange={(v) => {
          setDeposit(v);
          tx.reset();
        }}
        decimals={Q.decimals}
        token={pw.button}
        helper="Prepaid tax; the rest comes back when you leave"
        balance={address ? <span className="num">Balance {fmtToken(pw.bal ?? 0n, P)}</span> : undefined}
        onMax={address && bal ? () => setDeposit(toInput(bal > z.toHolder + z.bond ? bal - z.toHolder - z.bond : 0n, Q.decimals)) : undefined}
        testId="zap-deposit"
      />
      {pw.picker}
      <AmountInput
        big={false}
        label="Your price for the slot"
        value={price}
        onChange={setPrice}
        decimals={Q.decimals}
        token={<TokenButton symbol={Q.symbol} address={Q.address} />}
        helper={vacant ? "Anyone can take the slot from you at this price" : `Current LP's price ${fmtToken(seat.price, Q)}`}
        testId="zap-price"
      />
      <div className="well flex items-center gap-3 px-4 py-3" data-testid="zap-receive">
        <span className="min-w-0 flex-1">
          <span className="block text-caption font-medium text-ink-2">You receive</span>
          <span className="num block text-amount font-medium text-ink">{fmtToken(z.lpBalance, Q, false)}</span>
        </span>
        <span className="inline-flex h-10 items-center gap-2 rounded-full bg-surface px-3 shadow-whisper">
          <LpIcon asset={A} quote={Q} size={20} />
          <span className="text-body-sm font-medium">{sym}</span>
        </span>
      </div>
      <div data-testid="zap-breakdown">
      <DetailRows
        rows={[
          { k: vacant ? "To the current LP" : `To the current LP (${short(seat.holder)})`, v: vacant ? "Nothing, the slot is free" : fmtToken(z.toHolder, Q) },
          { k: "Bond", v: fmtToken(z.bond, Q), hint: "returned when you leave" },
          { k: "Prepaid tax", v: fmtToken(z.deposit, Q) },
          { k: "You pay", v: fmtToken(z.total, Q), testId: "zap-total" },
          { k: "Tax at your price", v: p > 0n ? `${fmtToken(z.yearly, Q)} a year` : "—", hint: `${taxBps / 100}% of your price` },
          { k: "Prepaid tax lasts", v: p > 0n && d > 0n && days !== undefined ? (days >= 1 ? `about ${Math.floor(days)} days` : `about ${fmtWait(z.lasts)}`) : "—" },
        ]}
      />
      </div>
      <TxErrorLine error={tx.lastError} />
      <WalletAction>
        <Button variant="primary" size="lg" block disabled={!can || tx.busy} loading={tx.busy} onClick={go} data-testid="zap-in-button">
          {stageLabel(tx.steps, label)}
        </Button>
      </WalletAction>
      <StepsLine steps={tx.steps} labels={can && (pw.native || needsApprove) ? [...(pw.native ? [`Wrap ${P.symbol}`] : []), ...(allowance === undefined || allowance < z.total ? [`Approve ${Q.symbol}`] : []), "Zap in"] : undefined} />
    </div>
  );
}

function Manage({ m, A, Q, seat, registry, mine, account }: { m: Market; A: Token; Q: Token; seat: SeatView; registry: `0x${string}`; mine: boolean; account?: string }) {
  const tx = useTx();
  const { now: cn } = useChainClock();
  const now = useLiveNow() || cn;
  const [price, setPrice] = useState("");
  const [top, setTop] = useState("");
  const p = parseAmount(price, Q.decimals);
  const t = parseAmount(top, Q.decimals);
  // the top-up pays the loan token too, so HYPE / MON can pay for a WHYPE / WMON slot (wrapped first)
  const pw = usePayWith(Q);
  const chainId = useActiveChainId();
  if (!mine)
    return (
      <div className="space-y-3">
        <p className="text-body-sm text-ink-2">Only the LP can manage this slot. Zap in to become the LP.</p>
        <Collect m={m} Q={Q} seat={seat} registry={registry} account={account} />
      </div>
    );
  const locked = priceLocked(seat, p, now);
  return (
    <div className="space-y-5" data-testid="zap-manage">
      <LpOrderForm m={m} A={A} Q={Q} seat={seat} registry={registry} now={now} />
      <section className="space-y-2">
        <AmountInput big={false} label="Top up prepaid tax" value={top} onChange={setTop} decimals={Q.decimals} token={pw.button} helper={`Left now: ${fmtToken(seat.deposit, Q)}`} testId="zap-topup" />
        {pw.picker}
        <Button
          size="md"
          variant="secondary"
          block
          disabled={t === 0n || tx.busy}
          onClick={() =>
            void tx.run(async () => {
              const a = await tx.ensureAllowance(Q.address, t, registry, { symbol: Q.symbol });
              const w = [a, seatTopUpWrite(registry, m, t, Q)].filter((x): x is Write => !!x);
              return pw.native ? withWrap(chainId, t, w) : w;
            }, { onSuccess: () => setTop("") })
          }
        >
          {pw.native ? `Wrap ${pw.P?.symbol} and top up` : "Top up"}
        </Button>
      </section>
      <section className="space-y-2">
        <AmountInput
          big={false}
          label="Change your price"
          value={price}
          onChange={setPrice}
          decimals={Q.decimals}
          token={<TokenButton symbol={Q.symbol} address={Q.address} />}
          helper={now < seat.priceLockedUntil ? `Now ${fmtToken(seat.price, Q)}. Can be lowered after ${fmtExpiry(seat.priceLockedUntil)}` : `Now ${fmtToken(seat.price, Q)}`}
          error={locked ? "Too soon to lower your price" : undefined}
        />
        <Button size="md" variant="secondary" block disabled={p === 0n || locked || tx.busy} onClick={() => void tx.run([{ ...seatPriceWrite(registry, m, p, Q, fmtExpiry(seat.priceLockedUntil)), label: "Change price" }], { onSuccess: () => setPrice("") })}>
          Change price
        </Button>
      </section>
      <TxErrorLine error={tx.lastError} />
      <Collect m={m} Q={Q} seat={seat} registry={registry} account={account} />
    </div>
  );
}

/** Earnings, a buy-out payment or a returned bond waiting in the registry, moved to the wallet. */
function Collect({ m, Q, seat, registry, account }: { m: Market; Q: Token; seat: SeatView; registry: `0x${string}`; account?: string }) {
  const tx = useTx();
  const unsplit = holderUnsplitShare(seat, account);
  const total = seat.mine + unsplit;
  if (total === 0n) return null;
  return (
    <section className="space-y-2" data-testid="lp-collect">
      <p className="tabular-nums text-body-sm text-ink-2">
        <strong className="font-semibold text-ink">{fmtToken(total, Q)}</strong> is yours to withdraw: earnings, payments for your slot and returned bonds.
      </p>
      <Button size="md" variant="primary" block loading={tx.busy} onClick={() => void tx.run([...(unsplit > 0n ? [{ ...seatSplitWrite(registry, m), label: "Add earnings" }] : []), { ...seatWithdrawWrite(registry, m.quote), label: `Withdraw ${Q.symbol}` }], { successMessage: "Withdrawn to your wallet." })}>
        Withdraw {fmtToken(total, Q)}
      </Button>
      <TxErrorLine error={tx.lastError} />
    </section>
  );
}

function ZapOut({ m, Q, seat, registry, mine, account }: { m: Market; Q: Token; seat: SeatView; registry: `0x${string}`; mine: boolean; account?: string }) {
  const tx = useTx();
  if (!mine)
    return (
      <div className="space-y-3">
        <p className="text-body-sm text-ink-2">You don&apos;t hold this LP slot.</p>
        <Collect m={m} Q={Q} seat={seat} registry={registry} account={account} />
      </div>
    );
  const earnings = seat.mine + holderUnsplitShare(seat, account);
  const back = exitReturn(seat) + earnings;
  return (
    <div className="space-y-3" data-testid="zap-out">
      <DetailRows
        rows={[
          { k: "Prepaid tax left", v: fmtToken(seat.deposit, Q) },
          { k: "Bond", v: fmtToken(seat.bond, Q) },
          earnings > 0n && { k: "Earnings waiting", v: fmtToken(earnings, Q) },
          { k: "You get back", v: fmtToken(back, Q), testId: "zap-out-total" },
        ]}
      />
      <p className="text-caption text-ink-3">The slot becomes free for anyone, and your LP token goes to zero. Orders you already placed stay in their round.</p>
      <TxErrorLine error={tx.lastError} />
      <Button
        variant="primary"
        size="lg"
        block
        loading={tx.busy}
        onClick={() => void tx.run([{ ...seatReleaseWrite(registry, m), label: "Zap out" }, { ...seatWithdrawWrite(registry, m.quote), label: `Withdraw ${Q.symbol}` }], { successMessage: `${fmtToken(back, Q)} on its way to your wallet.` })}
        data-testid="zap-out-button"
      >
        {stageLabel(tx.steps, `Zap out and get ${fmtToken(back, Q)}`)}
      </Button>
      <StepsLine steps={tx.steps} labels={["Zap out", `Withdraw ${Q.symbol}`]} />
    </div>
  );
}
