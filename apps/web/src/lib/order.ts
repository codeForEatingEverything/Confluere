/**
 * Order math for the order form and its review (FRONTEND_DESIGN §3.1, §3.3). All bigint; the APR is the only float.
 * Prices are quote base units per one whole asset, like the contract.
 */
import { Side, buyEscrow, impliedApr, quoteDown, repayAmount, scaleOf, spreadFee } from "@confluere/sdk";
import type { PoolRow } from "./data";
import { isPegged } from "./markets";

export type OrderSide = "borrow" | "lend";
export type Pricing = "limit" | "market";

export const TTL_OPTIONS = [1, 2, 4, 12, 48] as const;
export const defaultTtl = (p: Pick<PoolRow, "cadence">) => (p.cadence === 0 ? 4 : 1);

/** Default cap for at-price lend orders: K × 99% (pegged pools K × 99.5%), the vaults' rule. */
export const defaultCap = (p: Pick<PoolRow, "strike" | "bandBps">) => (p.strike * (isPegged(p) ? 9950n : 9900n)) / 10_000n;

export type OrderInput = {
  pool: PoolRow;
  side: OrderSide;
  pricing: Pricing;
  amount: bigint; // asset units, or the quote budget for an at-price lend order
  limit: bigint; // competitive limit; 0 for at-price orders
  guard: bigint; // floor (at-price borrow) or cap (at-price lend); written into `limit`, never sets the price
  ttl: number;
  now: number;
};

export type OrderMath = {
  orderSide: Side;
  units: bigint; // units sent in the order (0 for an at-price lend order)
  limit: bigint;
  budget: bigint;
  escrow: bigint;
  escrowIsQuote: boolean;
  price: bigint; // the price the review assumes: the limit, or last P* for at-price orders
  estimate: boolean; // true when the review relies on last P*
  expectedUnits: bigint; // R (borrow) or C (lend) if filled
  proceeds: bigint; // quote received by a borrower if filled (>= for limit orders)
  buyBack: bigint; // repayAmount(units, K)
  cost: bigint; // buy-back minus proceeds
  apr: number; // (K − price)/price annualised to expiry
  protocolShare: bigint; // spread share inside the buy-back
  notional: bigint; // value checked against minNotional: at K, or the budget
};

export function orderMath(i: OrderInput): OrderMath {
  const p = i.pool;
  const scale = scaleOf(p.assetDecimals);
  const market = i.pricing === "market";
  const lend = i.side === "lend";
  const price = market ? p.lastClearingPrice : i.limit;
  const orderSide = lend ? (market ? Side.NcBuy : Side.Buy) : market ? Side.NcSell : Side.Sell;
  const budget = lend && market ? i.amount : 0n;
  const units = lend && market ? 0n : i.amount;
  const expectedUnits = lend && market ? (price > 0n ? (i.amount * scale) / price : 0n) : i.amount;
  const escrow = !lend ? i.amount : market ? i.amount : buyEscrow(i.amount, i.limit, i.ttl, scale);
  const proceeds = price > 0n ? quoteDown(expectedUnits, price, scale) : 0n;
  const buyBack = repayAmount(expectedUnits, p.strike, scale);
  const cost = buyBack > proceeds ? buyBack - proceeds : 0n;
  const vwap = price > 0n ? price : p.vwap;
  return {
    orderSide,
    units,
    limit: market ? i.guard : i.limit,
    budget,
    escrow,
    escrowIsQuote: lend,
    price,
    estimate: market,
    expectedUnits,
    proceeds,
    buyBack,
    cost,
    apr: price > 0n ? impliedApr(price, p.strike, p.expiry - i.now) : 0,
    protocolShare: spreadFee(expectedUnits, p.strike, vwap, p.feeBps, scale),
    notional: lend && market ? i.amount : quoteDown(i.amount, p.strike, scale),
  };
}

/** At-price band around the band base: ±bandBps, widened 1.5x per failed batch (display only). */
export function bandRange(p: Pick<PoolRow, "bandBps" | "bandFailures" | "bandBase" | "lastClearingPrice">): { lo: bigint; hi: bigint; widen: number } | undefined {
  const base = p.bandBase > 0n ? p.bandBase : p.lastClearingPrice;
  if (base === 0n) return undefined;
  const widen = 1.5 ** (p.bandFailures ?? 0);
  const bps = BigInt(Math.round(p.bandBps * widen));
  return { lo: (base * (10_000n - (bps > 10_000n ? 10_000n : bps))) / 10_000n, hi: (base * (10_000n + bps)) / 10_000n, widen };
}

export const SIDE_LABEL: Record<number, string> = {
  [Side.Sell]: "Borrow",
  [Side.Buy]: "Lend",
  [Side.NcSell]: "Borrow at-price",
  [Side.NcBuy]: "Lend at-price",
  [Side.Bid]: "Bid",
};
