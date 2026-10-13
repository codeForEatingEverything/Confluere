"use client";

import Link from "next/link";
import type { PoolRow, Token } from "@/lib/data";
import { fmtExpiry, fmtToken, fmtWait } from "@/lib/format";
import type { WatchState } from "@/lib/orderStatus";
import { useBlockTime } from "@/lib/data";
import { nextRoundAt, roundProgress, roundSeconds } from "@/lib/view";
import { isPaused } from "@/lib/window";
import { StatusPill } from "../ui/Surface";
import { Button } from "../ui/Button";

/** "Fills in about 1 min 40 s" with the round ring; "Paused until …" when the guardian paused the market. */
export function RoundPill({ pool, now, block }: { pool: PoolRow; now: number; block: bigint }) {
  const spb = useBlockTime().data;
  if (isPaused(pool, block)) {
    const until = spb ? now + Number(pool.pausedUntil - block) * spb : undefined;
    return <StatusPill tone="warn">{until ? `Paused until ${fmtExpiry(Math.round(until))}` : "Paused for now"}</StatusPill>;
  }
  if (!now) return null;
  return (
    <StatusPill progress={roundProgress(pool, now)} data-testid="round-pill">
      Fills in about {fmtWait(nextRoundAt(pool, now) - now)}
    </StatusPill>
  );
}

/** What happened after "Place order" (§8.1.8), replacing the round pill until the user dismisses it. */
export function OrderStatus({
  watch,
  side,
  asset,
  quote,
  pool,
  now,
  onWithdraw,
  onDismiss,
}: {
  watch: WatchState | "signing";
  side: "borrow" | "lend";
  asset: Token;
  quote: Token;
  pool: PoolRow;
  now: number;
  onWithdraw?: () => void;
  onDismiss: () => void;
}) {
  const dismiss = (
    <button type="button" className="text-caption font-medium underline underline-offset-2" onClick={onDismiss}>
      Done
    </button>
  );
  if (watch === "signing") return <StatusPill tone="neutral" live>Confirm in your wallet</StatusPill>;
  const wait = fmtWait(nextRoundAt(pool, now) - now);
  const withdraw = onWithdraw ? (
    <Button size="sm" variant="primary" onClick={onWithdraw}>
      Withdraw
    </Button>
  ) : null;
  switch (watch.phase) {
    case "placed":
      return (
        <StatusPill progress={roundProgress(pool, now)} action={<Link href="/portfolio" className="text-caption font-medium underline underline-offset-2">View in Portfolio</Link>} live data-testid="order-status">
          Submitted. Fills in about {wait}.
        </StatusPill>
      );
    case "retrying":
      return (
        <StatusPill tone="warn" progress={roundProgress(pool, now)} action={<Link href="/portfolio" className="text-caption font-medium underline underline-offset-2">View in Portfolio</Link>} live data-testid="order-status">
          Not filled this round. Trying again ({watch.round} of {watch.of}).
        </StatusPill>
      );
    case "filled":
      return side === "borrow" ? (
        <StatusPill tone="good" action={<span className="flex items-center gap-3">{withdraw}{dismiss}</span>} live data-testid="order-status">
          Filled. {fmtToken(watch.received, quote)} is ready to withdraw.
        </StatusPill>
      ) : (
        <StatusPill tone="good" action={<span className="flex items-center gap-3"><Link href="/portfolio" className="text-caption font-medium underline underline-offset-2">See it in Portfolio</Link>{dismiss}</span>} live data-testid="order-status">
          Filled. You are lending against {fmtToken(watch.units, asset)} of collateral.
        </StatusPill>
      );
    case "expired":
      return (
        <StatusPill tone="neutral" action={<span className="flex items-center gap-3">{withdraw}{dismiss}</span>} live data-testid="order-status">
          Expired after {watch.of} round{watch.of > 1 ? "s" : ""}. Nothing happened; your {side === "borrow" ? asset.symbol : quote.symbol} is back.
        </StatusPill>
      );
    case "cancelled":
      return (
        <StatusPill tone="neutral" action={<span className="flex items-center gap-3">{withdraw}{dismiss}</span>} live data-testid="order-status">
          Cancelled. Your {side === "borrow" ? asset.symbol : quote.symbol} is back.
        </StatusPill>
      );
  }
}

/** "Each round is about 2 min on this network". */
export const roundLine = (pool: PoolRow) => `Each round is about ${fmtWait(roundSeconds(pool))} on this network`;
