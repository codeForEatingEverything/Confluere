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

// ------------------------------------------------------------ 1% log strike grid (Grid.sol, bit-identical)

export const GRID_RAY = 10n ** 27n;
export const GRID_STEP = 101n * 10n ** 25n; // 1.01 in RAY, exact
export const MAX_STRIKE_INDEX = 4095;
const UINT96_MAX = (1n << 96n) - 1n;

/** 1.01^m in RAY by repeated squaring, every product rounded down; line-by-line copy of Grid.growth. */
export function gridGrowth(m: number): bigint {
  let r = GRID_RAY;
  let b = GRID_STEP;
  let k = BigInt(m);
  while (k !== 0n) {
    if ((k & 1n) === 1n) r = (r * b) / GRID_RAY;
    k >>= 1n;
    if (k !== 0n) b = (b * b) / GRID_RAY;
  }
  return r;
}

/** Strike at grid index n: one whole quote unit times 1.01^n, rounded down (Grid.strikeAt). */
export function strikeAt(n: number, quoteDecimals: number): bigint {
  const unit = 10n ** BigInt(quoteDecimals);
  return n >= 0 ? (unit * gridGrowth(n)) / GRID_RAY : (unit * GRID_RAY) / gridGrowth(-n);
}

/** K is on the grid at index n: |n| <= 4095, 0 < K <= uint96 max, K == strikeAt(n) and n is the smallest such index. */
export function isGridStrike(strike: bigint, n: number, quoteDecimals: number): boolean {
  if (n > MAX_STRIKE_INDEX || n < -MAX_STRIKE_INDEX || strike <= 0n || strike > UINT96_MAX) return false;
  if (strikeAt(n, quoteDecimals) !== strike) return false;
  return n === -MAX_STRIKE_INDEX || strikeAt(n - 1, quoteDecimals) < strike;
}

/** Smallest n with strikeAt(n) >= strike (Grid.indexOf binary search); `ok` tells whether strike is on the grid. */
export function gridIndexOf(strike: bigint, quoteDecimals: number): { n: number; ok: boolean } {
  let lo = -MAX_STRIKE_INDEX;
  let hi = MAX_STRIKE_INDEX;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (strikeAt(mid, quoteDecimals) >= strike) hi = mid;
    else lo = mid + 1;
  }
  return { n: lo, ok: isGridStrike(strike, lo, quoteDecimals) };
}

/** Canonical index of an on-grid strike, or undefined when the strike is off the grid. */
export function strikeIndexOf(strike: bigint, quoteDecimals: number): number | undefined {
  const { n, ok } = gridIndexOf(strike, quoteDecimals);
  return ok ? n : undefined;
}

/** The canonical grid strikes just below-or-at and just above `price` (quote base units per whole asset). */
export function nearestGridStrikes(price: bigint, quoteDecimals: number): { below?: { n: number; strike: bigint }; above?: { n: number; strike: bigint } } {
  const { n } = gridIndexOf(price, quoteDecimals);
  const k = strikeAt(n, quoteDecimals);
  const out: { below?: { n: number; strike: bigint }; above?: { n: number; strike: bigint } } = {};
  if (k === price) {
    out.below = { n, strike: k };
    for (let m = n + 1; m <= MAX_STRIKE_INDEX; m++) {
      const s = strikeAt(m, quoteDecimals);
      if (s > k) { out.above = { n: m, strike: s }; break; }
    }
  } else {
    if (k > price && k <= UINT96_MAX) out.above = { n: gridIndexOf(k, quoteDecimals).n, strike: k };
    if (n > -MAX_STRIKE_INDEX) {
      const s = strikeAt(n - 1, quoteDecimals);
      if (s > 0n) out.below = { n: gridIndexOf(s, quoteDecimals).n, strike: s };
    }
  }
  return out;
}

/** Next expiry strictly after `now` on the grid. */
export const nextExpiry = (anchor: number, period: number, now: number): number =>
  anchor + (Math.floor((now - anchor) / period) + 1) * period;

/** Start of the next batch boundary after `lastSettledBatch`. */
export const nextBatchAt = (anchor: number, interval: number, lastSettledBatch: number): number =>
  anchor + (lastSettledBatch + 1) * interval;

/**
 * End of the batch a seat holder missed, using the evidence pool's own batch length; mirrors SeatRegistry.slash.
 * v0.8: the holder must miss `batches` (default 2) consecutive full batches of the pool after the base batch of the
 * holder's last quote.
 */
export function missedBatchEnd(anchor: number, baseInterval: number, lastQuotedBatch: number, poolInterval: number, batches = 2): number {
  const quotedEnd = anchor + (lastQuotedBatch + 1) * baseInterval;
  const start = anchor + Math.ceil((quotedEnd - anchor) / poolInterval) * poolInterval;
  return start + batches * poolInterval;
}

/** Human label for a pool's batch cadence (0 / 1 / 2 -> every base interval, 12x, 48x). */
export const cadenceMultiplier = (cadence: number): number => (cadence === 0 ? 1 : cadence === 1 ? 12 : 48);

/** Standard price band (bps) for a pair class: pegged 150, main 800, long tail 1500. */
export const standardBand = (cls: "pegged" | "main" | "longtail"): number => (cls === "pegged" ? 150 : cls === "main" ? 800 : 1500);

// ------------------------------------------------------------ Specials (in-kind lending, decision A)

/** Minimum margin Specials must post to lend `units`: ceil(units * lastClearingPrice * 12000 / (scale * 10000)). */
export const lendMinMargin = (units: bigint, lastPrice: bigint, scale: bigint): bigint =>
  (units * lastPrice * 12_000n + scale * BPS - 1n) / (scale * BPS);

/** Quote margin a repayer gets for `uShort` overdue units: all of it for the last ones, else pro rata rounded down. */
export function shortMarginShare(uShort: bigint, shortUnits: bigint, shortMargin: bigint): bigint {
  if (uShort === 0n || shortUnits === 0n) return 0n;
  return uShort >= shortUnits ? shortMargin : (shortMargin * uShort) / shortUnits;
}

/** Physical asset a pool can hand out: assetBal - lentUnits - shortUnits. */
export const physicalAsset = (assetBal: bigint, lentUnits: bigint, shortUnits: bigint): bigint => {
  const x = assetBal - lentUnits - shortUnits;
  return x > 0n ? x : 0n;
};

/** What repay(units) returns with overdue lending: asset first, the rest as K-equivalent margin compensation. */
export function repayOutcome(units: bigint, assetBal: bigint, lentUnits: bigint, shortUnits: bigint, shortMargin: bigint): { assetOut: bigint; uShort: bigint; marginOut: bigint } {
  const phys = physicalAsset(assetBal, lentUnits, shortUnits);
  const assetOut = units < phys ? units : phys;
  let uShort = units - assetOut;
  if (uShort > shortUnits) uShort = shortUnits;
  return { assetOut, uShort, marginOut: shortMarginShare(uShort, shortUnits, shortMargin) };
}

// ------------------------------------------------------------ autoSell (decision B)

/** Limit of the pool-owned autoSell order: K * (10000 - discountBps) / 10000, rounded down. */
export const autoSellLimit = (strike: bigint, discountBps: bigint | number): bigint => (strike * (BPS - BigInt(discountBps))) / BPS;
