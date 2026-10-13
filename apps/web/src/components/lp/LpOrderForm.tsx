"use client";

/**
 * The LP's duty (IA v3.1 item 8): one order near the market price in every round, worth at least the market's minimum.
 * The order is the LP's own (fills and refunds go to the LP) but cannot be cancelled before its round. It must be
 * close to the last traded price: a lend order at least, a borrow order at most, that price moved by the pool's
 * allowed range. Before the first trade any price is allowed.
 */
import { useState } from "react";
import { usePublicClient } from "wagmi";
import { useDemoClientOr } from "@/lib/demo/hooks";
import { useActiveChain } from "@/lib/activeChain";
import type { Token } from "@/lib/data";
import { tradingPools, type Market } from "@/lib/markets";
import { currentBatch, obligationBand, obligationValue, withinObligationBand, type SeatView } from "@/lib/seats";
import { seatQuoteHeld, seatQuoteWrite } from "@/lib/proActions";
import { fmtChip, fmtPer, fmtToken, fmtWait, parseAmount } from "@/lib/format";
import { buyBack } from "@/lib/view";
import { useTx, type Write } from "@/lib/tx";
import { AmountInput, Button, Segmented, StatusPill, TokenButton, TxErrorLine } from "../ui";

export function LpOrderForm({ m, A, Q, seat, registry, now }: { m: Market; A: Token; Q: Token; seat: SeatView; registry: `0x${string}`; now: number }) {
  const { deployment, chainId } = useActiveChain();
  const client = useDemoClientOr(usePublicClient({ chainId }), chainId);
  const tx = useTx();
  const open = tradingPools(m, now);
  const [pid, setPid] = useState(open[0]?.id);
  const [side, setSide] = useState<"lend" | "borrow">("lend");
  const [size, setSize] = useState("");
  const [limit, setLimit] = useState("");
  const pool = open.find((p) => p.id === pid) ?? open[0];
  const round = deployment ? currentBatch(now, deployment.gridAnchor, deployment.batchInterval) : 0;
  const roundEnd = deployment ? deployment.gridAnchor + (round + 1) * deployment.batchInterval : now;
  const done = seat.lastQuotedBatch >= round;
  if (!pool)
    return (
      <section className="space-y-2" data-testid="lp-order">
        <h3 className="text-body font-semibold">This round&apos;s order</h3>
        <p className="text-body-sm text-ink-2">No maturity of this market is open right now, so there is nothing to keep an order in.</p>
      </section>
    );
  const lend = side === "lend";
  const units = parseAmount(size, A.decimals);
  const lim = parseAmount(limit, Q.decimals);
  const guard = obligationBand(pool.lastClearingPrice, pool.bandBps, lend);
  const inRange = lim === 0n || withinObligationBand(lim, guard);
  const worth = obligationValue(units, lim, pool, lend);
  const held = seatQuoteHeld(pool, lend, units, lim);
  const tok = lend ? Q : A;
  return (
    <section className="space-y-3" data-testid="lp-order">
      <h3 className="text-body font-semibold">This round&apos;s order</h3>
      <StatusPill tone={done ? "good" : "warn"}>{done ? "Done for this round." : `Place it before this round ends, in about ${fmtWait(Math.max(0, roundEnd - now))}.`}</StatusPill>
      {open.length > 1 && <Segmented label="Maturity" value={pool.id} onChange={setPid} options={open.slice(0, 3).map((p) => ({ value: p.id, label: `${fmtChip(p.expiry)}, ${fmtPer(buyBack(p), Q)}` }))} />}
      <Segmented label="Side" value={side} onChange={setSide} options={[{ value: "lend", label: "Lend" }, { value: "borrow", label: "Borrow" }]} />
      <AmountInput big={false} label="Size" value={size} onChange={setSize} decimals={A.decimals} token={<TokenButton symbol={A.symbol} address={A.address} />} />
      <AmountInput big={false} label={`Price per ${A.symbol}`} value={limit} onChange={setLimit} decimals={Q.decimals} token={<TokenButton symbol={Q.symbol} address={Q.address} />} />
      <p className="text-caption text-ink-3">
        {guard.min !== undefined ? `At least ${fmtPer(guard.min, Q)} (close to last traded).` : guard.max !== undefined ? `At most ${fmtPer(guard.max, Q)} (close to last traded).` : "No trade yet, so any price is allowed."} Worth at least {fmtToken(seat.obligation, Q)}. Held: {fmtToken(held, tok)}, for 2 rounds.
      </p>
      {!inRange && <p className="text-body-sm text-bad">This price is too far from last traded.</p>}
      {units > 0n && worth < seat.obligation && <p className="text-body-sm text-bad">Worth {fmtToken(worth, Q)}, below the minimum.</p>}
      <TxErrorLine error={tx.lastError} />
      <Button
        variant="primary"
        size="md"
        block
        disabled={units === 0n || lim === 0n || !inRange || worth < seat.obligation || tx.busy || !client || !deployment}
        loading={tx.busy}
        onClick={() =>
          void tx.run(async () => {
            const a = await tx.ensureAllowance(tok.address, held, registry, { symbol: tok.symbol });
            return [a, { ...(await seatQuoteWrite(client as never, deployment!.confluere, registry, pool, lend, units, lim)), label: "Place order" }].filter((x): x is Write => !!x);
          })
        }
      >
        Place this round&apos;s order
      </Button>
    </section>
  );
}
