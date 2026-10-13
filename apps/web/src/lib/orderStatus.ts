"use client";

/**
 * What happened to an order after "Place order" (FRONTEND_V3 §8.1.8), in five words: placed, not filled this round
 * (trying again i of n), filled, expired, cancelled. Detection reads the chain: the buy-back rights (borrow) or lender
 * units (lend) the account holds, the balances waiting to be withdrawn, the pool's round counter, and the account's
 * open orders. The order's round budget is remembered per browser so Portfolio can say "Trying again (2 of 4)".
 */
import { useEffect, useMemo, useState } from "react";
import type { Hex } from "viem";
import { useAccountOrders, usePool, type AccountOrder, type PoolRow } from "./data";
import { usePending, usePositions } from "./position";

export type OrderSideWord = "borrow" | "lend";

export type WatchStart = {
  pool: PoolRow;
  side: OrderSideWord;
  /** Rounds the order keeps trying. */
  rounds: number;
  /** Units (borrow: collateral sold) or quote amount (lend) of the order, for messages. */
  amount: bigint;
  before: { held: bigint; pendingQuote: bigint; pendingAsset: bigint; orderIds: string[] };
};

export type WatchPhase = "placed" | "retrying" | "filled" | "expired" | "cancelled";
export type WatchState = { phase: WatchPhase; round: number; of: number; received: bigint; units: bigint; refund: bigint };

/** Pure reduction (unit-tested). `seen`: the new order showed up in the account's open orders at least once. */
export function watchState(
  w: Pick<WatchStart, "side" | "rounds" | "before"> & { startRounds: number },
  now: { roundsDone: number; held: bigint; pendingQuote: bigint; pendingAsset: bigint; open: boolean; seen: boolean },
): WatchState {
  const units = now.held > w.before.held ? now.held - w.before.held : 0n;
  const received = now.pendingQuote > w.before.pendingQuote ? now.pendingQuote - w.before.pendingQuote : 0n;
  const refundAsset = now.pendingAsset > w.before.pendingAsset ? now.pendingAsset - w.before.pendingAsset : 0n;
  const done = Math.max(0, now.roundsDone - w.startRounds);
  const base = { of: w.rounds, received, units, refund: w.side === "borrow" ? refundAsset : received };
  if (units > 0n) return { ...base, phase: "filled", round: Math.min(done, w.rounds) };
  if (done >= w.rounds && !now.open) return { ...base, phase: "expired", round: w.rounds };
  if (now.seen && !now.open) return { ...base, phase: "cancelled", round: done };
  if (done === 0) return { ...base, phase: "placed", round: 1 };
  return { ...base, phase: "retrying", round: Math.min(done + 1, w.rounds) };
}

const MEMO = (chainId: number) => `confluere.orders.${chainId}`;
type Memo = Record<string, { rounds: number; start: number; side: OrderSideWord }>;

function readMemo(chainId: number): Memo {
  try {
    return JSON.parse(localStorage.getItem(MEMO(chainId)) ?? "{}") as Memo;
  } catch {
    return {};
  }
}

export function rememberOrder(chainId: number, pid: Hex, id: bigint, v: { rounds: number; start: number; side: OrderSideWord }) {
  try {
    const m = readMemo(chainId);
    m[`${pid.toLowerCase()}:${id}`] = v;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete m[k];
    localStorage.setItem(MEMO(chainId), JSON.stringify(m));
  } catch {}
}

/** "Trying again (i of n)" for an order placed from this browser, or undefined. */
export function orderProgress(chainId: number, o: Pick<AccountOrder, "pid" | "id">, roundsDoneNow: number): { i: number; n: number } | undefined {
  const m = readMemo(chainId)[`${o.pid.toLowerCase()}:${o.id}`];
  if (!m) return undefined;
  const done = Math.max(0, roundsDoneNow - m.start);
  if (done === 0) return undefined;
  return { i: Math.min(done + 1, m.rounds), n: m.rounds };
}

/** Live status of an order placed from the card. */
export function useOrderWatch(start: (WatchStart & { chainId: number }) | undefined): WatchState | undefined {
  const pid = start?.pool.id;
  const pool = usePool(pid).data;
  const positions = usePositions(pid ? [pid] : []).data;
  const pending = usePending(start ? [start.pool.asset, start.pool.quote] : []).data;
  const orders = useAccountOrders().data;
  const [seenId, setSeenId] = useState<bigint>();
  const mine = useMemo(() => (orders ?? []).filter((o) => pid && o.pid.toLowerCase() === pid.toLowerCase()), [orders, pid]);
  const fresh = start ? mine.find((o) => !start.before.orderIds.includes(String(o.id))) : undefined;
  useEffect(() => {
    if (start && fresh && seenId === undefined) {
      setSeenId(fresh.id);
      rememberOrder(start.chainId, start.pool.id, fresh.id, { rounds: start.rounds, start: start.pool.settleCount, side: start.side });
    }
  }, [start, fresh, seenId]);
  if (!start) return undefined;
  const p = pool ?? start.pool;
  const pos = positions?.[start.pool.id];
  const held = pos ? (start.side === "borrow" ? pos.r : pos.c) : start.before.held;
  return watchState(
    { side: start.side, rounds: start.rounds, before: start.before, startRounds: start.pool.settleCount },
    {
      roundsDone: p.settleCount,
      held,
      pendingQuote: pending?.[start.pool.quote.toLowerCase()] ?? start.before.pendingQuote,
      pendingAsset: pending?.[start.pool.asset.toLowerCase()] ?? start.before.pendingAsset,
      open: seenId !== undefined ? mine.some((o) => o.id === seenId) : p.settleCount - start.pool.settleCount < start.rounds,
      seen: seenId !== undefined,
    },
  );
}
