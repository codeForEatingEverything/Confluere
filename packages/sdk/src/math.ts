/** Prices are quote base units per 1 whole asset (10 ** assetDecimals units), like the contract. */

const BPS = 10_000n;

export const scaleOf = (assetDecimals: number): bigint => 10n ** BigInt(assetDecimals);

export const quoteDown = (units: bigint, price: bigint, scale: bigint): bigint => (units * price) / scale;

export const quoteUp = (units: bigint, price: bigint, scale: bigint): bigint =>
  (units * price + scale - 1n) / scale;

/** v0.8 fees (contracts/src/libraries/Settlement.sol). */
export const SPREAD_SHARE_BPS = 500n; // 5% of the interest K - P*, per seller fill, withheld into the pool's fee escrow
export const TRADE_FEE_PPM = 150n; // 0.015% of notional on each side (0.03% per trade in total)
export const PPM = 1_000_000n;

/** Trade fee on a notional, rounded down: floor(x * 150 / 1e6). */
export const tradeFee = (notional: bigint): bigint => (notional * TRADE_FEE_PPM) / PPM;

/** Spread share on `units` filled at `price`: floor(units * (K - price) * 500 / (scale * 1e4)); zero at or above K. */
export function spreadShare(units: bigint, strike: bigint, price: bigint, scale: bigint): bigint {
  if (price >= strike) return 0n;
  return (units * (strike - price) * SPREAD_SHARE_BPS) / (scale * BPS);
}

/** Seller side of a fill: gross (rounded down), trade fee, spread share (capped so a fill never reverts), net. */
export function sellSplit(units: bigint, price: bigint, strike: bigint, scale: bigint): { gross: bigint; trade: bigint; spread: bigint; net: bigint } {
  const gross = quoteDown(units, price, scale);
  const trade = tradeFee(gross);
  let spread = spreadShare(units, strike, price, scale);
  if (spread > gross - trade) spread = gross - trade;
  return { gross, trade, spread, net: gross - trade - spread };
}

/** What a seller (borrower) keeps from a fill: gross - tradeFee(gross) - capped spread share. */
export const sellerNet = (units: bigint, price: bigint, strike: bigint, scale: bigint): bigint => sellSplit(units, price, strike, scale).net;

/** Buyer side of a fill: cost (rounded up), its trade fee, and the total debited from escrow. */
export function buyCost(units: bigint, price: bigint, scale: bigint): { cost: bigint; trade: bigint; total: bigint } {
  const cost = quoteUp(units, price, scale);
  const trade = tradeFee(cost);
  return { cost, trade, total: cost + trade };
}

/** Escrow a competitive buy order needs: cost at its limit (rounded up) + its trade fee + 2 wei per batch of ttl. */
export function buyEscrow(units: bigint, limit: bigint, ttl: number, scale: bigint): bigint {
  const g = quoteUp(units, limit, scale);
  return g + tradeFee(g) + 2n * BigInt(ttl);
}

/** Units an all-in non-competitive quote budget (cost + trade fee) buys at `price`, with 1 wei reserve. */
export function ncUnits(budget: bigint, price: bigint, scale: bigint): bigint {
  if (price <= 0n) return 0n;
  const b = (budget * PPM) / (PPM + TRADE_FEE_PPM);
  if (b <= 1n) return 0n;
  return ((b - 1n) * scale) / price;
}

/** Treasury part of a pool's fee escrow at close: escrow * repaidUnits / filledUnits; the rest goes to C holders. */
export function feeEscrowSplit(escrow: bigint, repaidUnits: bigint, filledUnits: bigint): { toTreasury: bigint; toLenders: bigint } {
  const toTreasury = filledUnits === 0n ? 0n : (escrow * repaidUnits) / filledUnits;
  return { toTreasury, toLenders: escrow - toTreasury };
}

/** What a borrower pays to buy back `units` at strike K. Repay carries no fee since v0.8. */
export const repayAmount = (units: bigint, strike: bigint, scale: bigint): bigint => quoteUp(units, strike, scale);

/**
 * Top-up a rollover order must pre-fund (mirrors OrderLogic.rollover): K_old - minPrice per unit, plus the seller's
 * trade fee and spread share (at the new pool's strike) at minPrice, plus 4 wei per batch of ttl.
 */
export function rolloverTopUp(units: bigint, strike: bigint, minPrice: bigint, ttl: number, scale: bigint, newStrike: bigint = strike): bigint {
  const gap = strike > minPrice ? quoteUp(units, strike - minPrice, scale) : 0n;
  return gap + tradeFee(quoteUp(units, minPrice, scale)) + spreadShare(units, newStrike, minPrice, scale) + 4n * BigInt(ttl);
}

/**
 * Lender's fixed return per unit if repaid: pays P + trade fee, receives K. The 5% spread share is withheld from the
 * seller at clearing, so the lender's claim on repayment is K per unit; on default the lender keeps the asset plus the
 * defaulted part of the fee escrow.
 */
export const lenderCostPerUnit = (price: bigint): bigint => price + tradeFee(price);

/** Borrower's proceeds per whole unit at `price`: P - trade fee - 5% of (K - P). */
export const borrowerNetPerUnit = (price: bigint, strike: bigint, scale: bigint): bigint => sellerNet(scale, price, strike, scale);

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
