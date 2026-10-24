/**
 * Quotes for the Borrow card and the Lend drawer (FRONTEND_V3 §8.1.4), pure bigint math on top of the SDK. Prices are
 * quote base units per 1 whole collateral, like the contract.
 *
 * A borrower sells `units` of collateral now at the round's price and buys them back for the buy-back price per unit
 * before the repayment window closes. A lender buys lender units at the round's price and is paid the buy-back price
 * per unit if the borrower buys back; otherwise the lender receives the collateral.
 *
 * Fees (v0.8, Settlement.sol): every fill pays a 0.015% trade fee on each side; the borrower's side also has 5% of
 * the interest (K − price) withheld into the pool's fee escrow. Repayment carries no fee. At close the escrow splits by
 * the repaid share: the repaid part goes to the treasury, the defaulted part to lenders.
 */
import { impliedApr, lenderCostPerUnit, ncUnits, quoteDown, quoteUp, repayAmount, scaleOf, sellSplit, tradeFee } from "@confluere/sdk";
import type { PoolRow } from "./data";
import { isPegged } from "./markets";
import { fmtWait, pct } from "./format";

const BPS = 10_000n;
export const DAY = 86_400;

/** A display-only reference price (float, quote per collateral) in quote base units per whole collateral. */
export function refToUnits(ref: number | undefined | null, quoteDecimals: number | undefined): bigint | undefined {
  if (!ref || !Number.isFinite(ref) || ref <= 0 || quoteDecimals === undefined) return undefined;
  return BigInt(Math.round(ref * 10 ** Math.min(quoteDecimals, 12))) * 10n ** BigInt(Math.max(0, quoteDecimals - 12));
}

/** Default "Max price move" for at-market orders: 0.5% in pegged markets, 1% elsewhere. */
export const defaultMoveBps = (p: Pick<PoolRow, "bandBps">) => (isPegged(p) ? 50 : 100);

/** Default minimum price per unit when the pool has no price at all: buy-back × 97% (pegged) or × 90%. */
export const defaultBorrowLimit = (p: Pick<PoolRow, "strike" | "bandBps">) => (p.strike * (isPegged(p) ? 9700n : 9000n)) / BPS;

export type BorrowQuote = {
  /** Price per unit this quote assumes (last traded, else the reference price, else 0). */
  price: bigint;
  /** True when the price is not the pool's own last traded price. */
  estimate: boolean;
  /** What the borrower gets: gross − trade fee − 5% spread share. */
  receive: bigint;
  /** units × price before fees. */
  gross: bigint;
  /** 0.015% trade fee on the gross. */
  tradeFee: bigint;
  /** 5% of (buy-back − price) × units, withheld into the pool's fee escrow. */
  spreadShare: bigint;
  repay: bigint;
  /** repay − receive: the interest plus every fee. */
  cost: bigint;
  /** cost / receive over this term. */
  periodReturn: number;
  apr: number;
  /** APR is shown only for terms of at least one day (§9.6). */
  showApr: boolean;
  /** Lowest price an at-market order accepts: price × (1 − move). */
  guard: bigint;
};

export function borrowQuote(i: { pool: PoolRow; units: bigint; ref?: bigint; now: number; moveBps?: number; limit?: bigint }): BorrowQuote {
  const p = i.pool;
  const scale = scaleOf(p.assetDecimals);
  const own = p.lastClearingPrice > 0n;
  const raw = i.limit && i.limit > 0n ? i.limit : own ? p.lastClearingPrice : (i.ref ?? 0n);
  // a round never clears at or above the buy-back price (a lender is paid at most that at maturity), so an estimate
  // from the reference price is capped just below it; the rate is then 0, never negative
  const price = raw >= p.strike && p.strike > 0n ? p.strike - 1n : raw;
  const split = price > 0n ? sellSplit(i.units, price, p.strike, scale) : { gross: 0n, trade: 0n, spread: 0n, net: 0n };
  const receive = split.net;
  const repay = repayAmount(i.units, p.strike, scale);
  const cost = repay > receive ? repay - receive : 0n;
  const left = p.expiry - i.now;
  const move = BigInt(i.moveBps ?? defaultMoveBps(p));
  const periodReturn = receive > 0n ? Number(cost) / Number(receive) : 0;
  return {
    price,
    estimate: !own || (!!i.limit && i.limit > 0n),
    receive,
    gross: split.gross,
    tradeFee: split.trade,
    spreadShare: split.spread,
    repay,
    cost,
    periodReturn,
    apr: receive > 0n && left > 0 ? Math.max(0, (periodReturn * 365 * DAY) / left) : 0,
    showApr: left >= DAY,
    guard: (price * (BPS - move)) / BPS,
  };
}

/** What a borrower keeps from `units` sold at `price`, net of the trade fee and the 5% spread share (0 when unpriced). */
export const netAtPrice = (p: Pick<PoolRow, "strike" | "assetDecimals">, units: bigint, price: bigint): bigint =>
  price > 0n ? sellSplit(units, price, p.strike, scaleOf(p.assetDecimals)).net : 0n;

export type LendQuote = {
  price: bigint;
  estimate: boolean;
  /** Lender units the amount buys at that price, the amount being all-in (cost + 0.015% trade fee). */
  units: bigint;
  /** units × price, rounded up as the core charges a buyer. */
  cost: bigint;
  /** 0.015% trade fee on the cost. */
  tradeFee: bigint;
  /** Paid if repaid: units × buy-back price. */
  payout: bigint;
  periodReturn: number;
  apr: number;
  showApr: boolean;
};

export function lendQuote(i: { pool: PoolRow; amount: bigint; ref?: bigint; now: number; limit?: bigint }): LendQuote {
  const p = i.pool;
  const scale = scaleOf(p.assetDecimals);
  const own = p.lastClearingPrice > 0n;
  const raw = i.limit && i.limit > 0n ? i.limit : own ? p.lastClearingPrice : (i.ref ?? 0n);
  // a round never clears at or above the buy-back price (a lender is paid at most that at maturity), so an estimate
  // from the reference price is capped just below it; the rate is then 0, never negative
  const price = raw >= p.strike && p.strike > 0n ? p.strike - 1n : raw;
  const units = price > 0n ? ncUnits(i.amount, price, scale) : 0n;
  const cost = price > 0n ? quoteUp(units, price, scale) : 0n;
  const fee = tradeFee(cost);
  const payout = quoteDown(units, p.strike, scale);
  const left = p.expiry - i.now;
  const paid = lenderCostPerUnit(price);
  return {
    price,
    estimate: !own || (!!i.limit && i.limit > 0n),
    units,
    cost,
    tradeFee: fee,
    payout,
    periodReturn: price > 0n ? Math.max(0, Number(p.strike - paid) / Number(paid)) : 0,
    apr: price > 0n ? Math.max(0, impliedApr(paid, p.strike, left)) : 0,
    showApr: left >= DAY,
  };
}

/** Fixed return of a pool at its last traded price: (buy-back − price) / price, and the APR when the term is ≥ 1 day. */
export function fixedReturn(p: Pick<PoolRow, "strike" | "lastClearingPrice" | "expiry">, now: number): { period: number; apr: number; showApr: boolean; priced: boolean } {
  const price = p.lastClearingPrice;
  if (price <= 0n) return { period: 0, apr: 0, showApr: false, priced: false };
  const left = p.expiry - now;
  return { period: Math.max(0, Number(p.strike - price) / Number(price)), apr: Math.max(0, impliedApr(price, p.strike, left)), showApr: left >= DAY, priced: true };
}

/** Smallest collateral amount whose value at the buy-back price reaches the core's minimum order size. */
export function minUnits(p: Pick<PoolRow, "strike" | "assetDecimals">, minNotional: bigint | undefined): bigint {
  if (!minNotional || minNotional <= 0n || p.strike <= 0n) return 0n;
  const s = scaleOf(p.assetDecimals);
  return (minNotional * s + p.strike - 1n) / p.strike;
}

/**
 * The lender's fixed return net of fees (v0.8): the lender pays price + 0.015% trade fee per unit and is paid the full
 * buy-back price K if repaid; the 5% spread share is withheld from the borrower's side, not the lender's (on default
 * the lender also gets the defaulted part of the pool's fee escrow). Same shape as `fixedReturn`.
 */
export function netReturn(p: Pick<PoolRow, "strike" | "lastClearingPrice" | "expiry">, now: number, price = p.lastClearingPrice): { period: number; apr: number; showApr: boolean; priced: boolean; netPerUnit: bigint } {
  if (price <= 0n) return { period: 0, apr: 0, showApr: false, priced: false, netPerUnit: 0n };
  const net = p.strike;
  const paid = lenderCostPerUnit(price);
  const left = p.expiry - now;
  const period = Number(net - paid) / Number(paid);
  return { period, apr: left > 0 ? (period * 365 * DAY) / left : 0, showApr: left >= DAY, priced: true, netPerUnit: net };
}

/** "4.12% APR" for terms of a day or more, "0.34% · 41 min" below that (an APR of a 40-minute term misleads). */
export function rateText(r: { period: number; apr: number; showApr: boolean }, left: number): string {
  if (left <= 0) return `${pct(r.period)} to maturity`;
  return r.showApr ? `${pct(r.apr)} APR` : `${pct(r.period)} · ${fmtWait(left)}`;
}

/** Short rate for tiles: "4.12% APR" (terms of a day or more) or "0.34%" with the period in the note. */
export function rateShort(r: { period: number; apr: number; showApr: boolean }): string {
  return r.showApr ? `${pct(r.apr)} APR` : pct(r.period);
}
