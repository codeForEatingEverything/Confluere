/**
 * Specials: borrow the asset itself out of a European pool (BLUEPRINT v0.8 §7.9, decision A, V08 spec §2.11 / §3.5).
 * Pure math mirroring Specials.open / close and the core's overdue accounting; the core re-checks everything.
 *
 * - Margin: at least 120% of the units' value at the pool's last clearing price, rounded up, posted in quote.
 * - Deadline: expiry − LEND_CUTOFF (Thursday 20:00 UTC for a Friday expiry on mainnet). Return the same token before it.
 * - No buy-in. Units not returned by the deadline become `shortUnits` and the whole margin is forfeited into the pool
 *   as `shortMargin`. A borrower who repays then gets the pool's asset first; for units the pool cannot deliver, the
 *   repayment K is credited back plus compensation shortMargin × units / shortUnits (pull, via pending). Short margin
 *   nobody claimed goes to the C holders when the window closes.
 */
import { Kind } from "@confluere/sdk";

export const MARGIN_BPS = 12_000n; // 120%
export const DEFAULT_LEND_CUTOFF = 12 * 3600; // mainnet: 12 h before a Friday 08:00 UTC expiry = Thursday 20:00 UTC

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Minimum margin in quote for `units` at `price` (quote per whole asset), asset scale `scale`. */
export function minMargin(units: bigint, price: bigint, scale: bigint): bigint {
  if (units <= 0n || price <= 0n) return 0n;
  return ceilDiv(units * price * MARGIN_BPS, scale * 10_000n);
}

/** Deadline to return lent units: expiry − cutoff. */
export const lendDeadline = (expiry: number, cutoff = DEFAULT_LEND_CUTOFF) => expiry - cutoff;

/** Only European pools still trading before the deadline, with a price and asset in the pool, can lend. */
export function canLend(p: { kind: Kind; expiry: number; lastClearingPrice: bigint; assetBal: bigint }, now: number, cutoff = DEFAULT_LEND_CUTOFF): boolean {
  return p.kind === Kind.European && p.lastClearingPrice > 0n && p.assetBal > 0n && now < lendDeadline(p.expiry, cutoff);
}

/** Margin returned when `units` of a loan are handed back (full return releases the whole margin). */
export const marginOut = (loan: { units: bigint; margin: bigint }, units: bigint) =>
  units >= loan.units ? loan.margin : (loan.margin * units) / loan.units;

export type LoanState = "open" | "due-soon" | "overdue" | "closed";

export function loanState(loan: { units: bigint }, expiry: number, now: number, cutoff = DEFAULT_LEND_CUTOFF): LoanState {
  if (loan.units === 0n) return "closed";
  const d = lendDeadline(expiry, cutoff);
  if (now >= d) return "overdue";
  return d - now < 24 * 3600 ? "due-soon" : "open";
}

/**
 * What a borrower repaying `units` R receives when the pool is short (decision A): asset from the pool first; for the
 * rest, K back in quote plus a share of the forfeited margin.
 */
export function shortRepay(
  units: bigint,
  pool: { assetAvailable: bigint; shortUnits: bigint; shortMargin: bigint; strike: bigint },
  scale: bigint,
): { asset: bigint; quoteBack: bigint; compensation: bigint } {
  const asset = units < pool.assetAvailable ? units : pool.assetAvailable;
  const short = units - asset;
  if (short === 0n || pool.shortUnits === 0n) return { asset, quoteBack: 0n, compensation: 0n };
  return { asset, quoteBack: ceilDiv(short * pool.strike, scale), compensation: (pool.shortMargin * short) / pool.shortUnits };
}

export const LOAN_LABEL: Record<LoanState, string> = {
  open: "Open",
  "due-soon": "Return soon",
  overdue: "Overdue · margin forfeited",
  closed: "Returned",
};
