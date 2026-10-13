/** Prices are quote base units per 1 whole asset (10 ** assetDecimals units), like the contract. */

const BPS = 10_000n;

export const scaleOf = (assetDecimals: number): bigint => 10n ** BigInt(assetDecimals);

export const quoteDown = (units: bigint, price: bigint, scale: bigint): bigint => (units * price) / scale;

export const quoteUp = (units: bigint, price: bigint, scale: bigint): bigint =>
  (units * price + scale - 1n) / scale;

/** Escrow a competitive buy order needs: units at its limit plus 1 wei of rounding reserve per batch of ttl. */
export const buyEscrow = (units: bigint, limit: bigint, ttl: number, scale: bigint): bigint =>
  quoteUp(units, limit, scale) + BigInt(ttl);

/** What a borrower pays to buy back `units` at strike K. */
export const repayAmount = (units: bigint, strike: bigint, scale: bigint): bigint => quoteUp(units, strike, scale);

/** Protocol spread share on a repayment: feeBps of (K - vwap), zero when vwap >= K. */
export function spreadFee(units: bigint, strike: bigint, vwap: bigint, feeBps: number, scale: bigint): bigint {
  if (strike <= vwap) return 0n;
  return (units * (strike - vwap) * BigInt(feeBps)) / (scale * BPS);
}

/** Top-up a rollover order must pre-fund (mirrors the contract's check). */
export function rolloverTopUp(units: bigint, strike: bigint, minPrice: bigint, ttl: number, scale: bigint): bigint {
  const gap = strike > minPrice ? quoteUp(units, strike - minPrice, scale) : 0n;
  return gap + 2n * BigInt(ttl);
}

/**
 * Lender's simple annualised yield implied by buying at `price` and receiving K at expiry, if repaid.
 * The worst case (default) is receiving the asset instead; this number does not price that.
 */
export function impliedApr(price: bigint, strike: bigint, secondsToExpiry: number): number {
  if (price <= 0n || secondsToExpiry <= 0) return 0;
  const r = Number(strike - price) / Number(price);
  return (r * 365 * 24 * 3600) / secondsToExpiry;
}

/** Discount of the clearing price to K, as a fraction (0.03 = borrower received 97% of K). */
export const haircut = (price: bigint, strike: bigint): number =>
  strike === 0n ? 0 : Number(strike - price) / Number(strike);

/** The contract's 2-significant-digit strike grid: strip trailing zeros, the rest must be < 10 ** digits. */
export function isGridStrike(strike: bigint, digits = 2): boolean {
  if (strike <= 0n) return false;
  let s = strike;
  while (s % 10n === 0n) s /= 10n;
  return s < 10n ** BigInt(digits);
}

/** Next expiry strictly after `now` on the grid. */
export const nextExpiry = (anchor: number, period: number, now: number): number =>
  anchor + (Math.floor((now - anchor) / period) + 1) * period;

/** Start of the next batch boundary after `lastSettledBatch`. */
export const nextBatchAt = (anchor: number, interval: number, lastSettledBatch: number): number =>
  anchor + (lastSettledBatch + 1) * interval;

/**
 * End of the batch a seat holder missed, using the evidence pool's own batch length; mirrors SeatRegistry.slash.
 * The missed batch is the pool's first full batch after the base batch of the holder's last quote.
 */
export function missedBatchEnd(anchor: number, baseInterval: number, lastQuotedBatch: number, poolInterval: number): number {
  const quotedEnd = anchor + (lastQuotedBatch + 1) * baseInterval;
  const start = anchor + Math.ceil((quotedEnd - anchor) / poolInterval) * poolInterval;
  return start + poolInterval;
}

/** Human label for a pool's batch cadence (0 / 1 / 2 -> every base interval, 12x, 48x). */
export const cadenceMultiplier = (cadence: number): number => (cadence === 0 ? 1 : cadence === 1 ? 12 : 48);
