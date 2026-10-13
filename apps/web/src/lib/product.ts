/**
 * Product-level selectors (pure, unit-tested): what the simple Borrow / Lend / Portfolio screens need, computed from
 * pool rows. Words used in comments match the UI vocabulary:
 * - a borrower SELLS collateral into a pool with a fixed maturity and gets the quote token now ("You receive");
 *   before the window closes they BUY IT BACK at the pool's fixed buy-back price ("Repay X by DATE"); otherwise the
 *   lenders keep the collateral. No liquidation, no price feed.
 * - a lender BUYS lender units below the buy-back price: paid the buy-back price per unit if repaid, otherwise the
 *   collateral. Fixed APR = (buy-back − price) / price, annualised to maturity.
 * Protocol names stay in code only: strike = buy-back price per 1 whole collateral, lastClearingPrice = last traded
 * price per 1 whole collateral (what a borrower received), C = lender units, R = borrower's buy-back right.
 */
import { Status, haircut, impliedApr, quoteDown, repayAmount, scaleOf } from "@confluere/sdk";
import type { Address, Hex } from "viem";
import type { PoolRow, VaultRow } from "./data";
import type { Position } from "./position";
import type { VaultMe } from "./vaultMe";
import { canRepay, canRollover, isPaused, windowOpen } from "./window";

export type StrikeTier = "low" | "mid" | "high";

export type Offer = {
  pool: PoolRow;
  id: Hex;
  expiry: number;
  /** Buy-back price per 1 whole collateral (quote base units). */
  strike: bigint;
  /** Last traded price per 1 whole collateral; 0 when the pool has never traded. */
  price: bigint;
  priced: boolean;
  /** Quote received per 1 whole collateral at the last price (= price). */
  receivePerUnit: bigint;
  /** Quote to repay per 1 whole collateral (= strike, rounded up like the contract). */
  repayPerUnit: bigint;
  /** Fixed APR implied by the last price (lender's yield if repaid = borrower's cost); 0 when unpriced. */
  apr: number;
  /** Display-only reference price (quote per collateral, float) when a source exists. */
  ref?: number;
  /** How far below the reference the borrower is paid: 1 − price / ref. */
  haircutVsRef?: number;
  /** Buy-back price relative to the reference: strike / ref (above 1: buying back costs more than market). */
  repayVsRef?: number;
  /** Discount of price to the buy-back price, (strike − price) / strike. */
  discount: number;
  tier: StrikeTier;
  /** Position of this strike among the term's strikes, 0 = lowest. */
  tierIndex: number;
  tierCount: number;
  /** Taking orders now: Open, before maturity, not paused. */
  open: boolean;
  graduated: boolean;
};

export type Term = {
  expiry: number;
  secondsLeft: number;
  /** Offers sorted by strike, lowest first. */
  offers: Offer[];
  /** Any offer of this term takes orders now. */
  open: boolean;
};

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** low / mid / high from a strike's rank among `count` strikes (one strike: mid; two: low and high). */
export function tierOf(index: number, count: number): StrikeTier {
  if (count <= 1) return "mid";
  if (index === 0) return "low";
  if (index === count - 1) return "high";
  return "mid";
}

/** `ref` in quote base units per whole collateral → float in quote tokens, for ratios with display prices. */
const toFloat = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;

export function offerOf(p: PoolRow, o: { now: number; block: bigint; ref?: number | null; quoteDecimals?: number; tierIndex?: number; tierCount?: number }): Offer {
  const scale = scaleOf(p.assetDecimals);
  const price = p.lastClearingPrice;
  const priced = price > 0n;
  const ref = o.ref && o.ref > 0 && Number.isFinite(o.ref) ? o.ref : undefined;
  const qd = o.quoteDecimals;
  const idx = o.tierIndex ?? 0;
  const cnt = o.tierCount ?? 1;
  return {
    pool: p,
    id: p.id,
    expiry: p.expiry,
    strike: p.strike,
    price,
    priced,
    receivePerUnit: price,
    repayPerUnit: repayAmount(scale, p.strike, scale),
    apr: priced ? impliedApr(price, p.strike, p.expiry - o.now) : 0,
    ref,
    haircutVsRef: ref && priced && qd !== undefined ? 1 - toFloat(price, qd) / ref : undefined,
    repayVsRef: ref && qd !== undefined ? toFloat(p.strike, qd) / ref : undefined,
    discount: priced ? haircut(price, p.strike) : 0,
    tier: tierOf(idx, cnt),
    tierIndex: idx,
    tierCount: cnt,
    open: p.status === Status.Open && o.now < p.expiry && !isPaused(p, o.block),
    graduated: p.graduated,
  };
}

/**
 * Pools of one collateral/quote pair (optionally one kind) grouped by maturity, soonest first. Only maturities that
 * still take orders are listed unless `includeClosed`.
 */
export function termsFor(
  pools: PoolRow[],
  q: { asset: Address; quote: Address; kind?: number; now: number; block: bigint; ref?: number | null; quoteDecimals?: number; includeClosed?: boolean },
): Term[] {
  const mine = pools.filter((p) => eq(p.asset, q.asset) && eq(p.quote, q.quote) && (q.kind === undefined || p.kind === q.kind));
  const byExpiry = new Map<number, PoolRow[]>();
  for (const p of mine) byExpiry.set(p.expiry, [...(byExpiry.get(p.expiry) ?? []), p]);
  const terms: Term[] = [];
  for (const [expiry, ps] of byExpiry) {
    const sorted = [...ps].sort((a, b) => cmpBig(a.strike, b.strike) || a.kind - b.kind);
    const strikes = [...new Set(sorted.map((p) => p.strike))];
    const offers = sorted.map((p) =>
      offerOf(p, { ...q, tierIndex: strikes.indexOf(p.strike), tierCount: strikes.length }),
    );
    const open = offers.some((o) => o.open);
    if (!open && !q.includeClosed) continue;
    terms.push({ expiry, secondsLeft: Math.max(0, expiry - q.now), offers, open });
  }
  return terms.sort((a, b) => a.expiry - b.expiry);
}

/** Narrow to the offers worth showing first: open, then priced, then graduated (each step only if it leaves some). */
function preferred(offers: Offer[]): Offer[] {
  let c = offers.filter((o) => o.open);
  for (const f of [(o: Offer) => o.priced, (o: Offer) => o.graduated]) {
    const n = c.filter(f);
    if (n.length) c = n;
  }
  return c;
}

/** Strike pick by tier among candidates sorted by strike: low = lowest, high = highest, mid = the middle one. */
function byTier(c: Offer[], tier: StrikeTier): Offer | undefined {
  if (c.length === 0) return undefined;
  const s = [...c].sort((a, b) => cmpBig(a.strike, b.strike));
  if (tier === "low") return s[0];
  if (tier === "high") return s[s.length - 1];
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * Best pool to borrow in for a maturity and a safety level. `low` = the lowest buy-back price (smallest amount per
 * unit, the most room before walking away makes sense), `high` = the highest (largest amount per unit). Prefers pools
 * with a last price (so "You receive" is known) and graduated markets. Without `expiry` the soonest open term is used.
 */
export function pickBorrowOffer(terms: Term[], o: { expiry?: number; tier: StrikeTier }): Offer | undefined {
  const term = o.expiry !== undefined ? terms.find((t) => t.expiry === o.expiry) : terms.find((t) => t.open);
  return term ? byTier(preferred(term.offers), o.tier) : undefined;
}

/**
 * Best pool to lend in: `apr` = highest fixed APR among priced open pools; `safe` = lowest buy-back price (lenders
 * are paid that or keep collateral bought furthest below it), highest APR among equals. Optional maturity filter.
 */
export function pickLendOffer(terms: Term[], o: { expiry?: number; goal: "apr" | "safe" }): Offer | undefined {
  const pool = (o.expiry !== undefined ? terms.filter((t) => t.expiry === o.expiry) : terms).flatMap((t) => t.offers);
  const c = preferred(pool).filter((x) => x.priced);
  if (c.length === 0) return undefined;
  if (o.goal === "apr") return [...c].sort((a, b) => b.apr - a.apr || cmpBig(a.strike, b.strike))[0];
  return [...c].sort((a, b) => cmpBig(a.strike, b.strike) || b.apr - a.apr)[0];
}

// ───────────────────────────── amounts ─────────────────────────────

/** Quote a borrower receives for `units` of collateral at the offer's last price (rounded down). */
export const borrowReceive = (o: Pick<Offer, "price" | "pool">, units: bigint) => quoteDown(units, o.price, scaleOf(o.pool.assetDecimals));

/** Quote to repay for `units` (buy-back price, rounded up like the contract). */
export const borrowRepay = (o: Pick<Offer, "strike" | "pool">, units: bigint) => repayAmount(units, o.strike, scaleOf(o.pool.assetDecimals));

/** Collateral needed to receive at least `quote` at the last price (rounded up); 0 when unpriced. */
export function unitsForQuote(o: Pick<Offer, "price" | "pool">, quote: bigint): bigint {
  if (o.price <= 0n || quote <= 0n) return 0n;
  const s = scaleOf(o.pool.assetDecimals);
  return (quote * s + o.price - 1n) / o.price;
}

/** Lender units a quote budget buys at the last price (rounded down); 0 when unpriced. */
export function lendUnits(o: Pick<Offer, "price" | "pool">, budget: bigint): bigint {
  if (o.price <= 0n) return 0n;
  return (budget * scaleOf(o.pool.assetDecimals)) / o.price;
}

/** What `units` lender units pay if repaid (buy-back price, rounded down as claims are). */
export const lendPayout = (o: Pick<Offer, "strike" | "pool">, units: bigint) => quoteDown(units, o.strike, scaleOf(o.pool.assetDecimals));

// ───────────────────────────── pairs (token selector) ─────────────────────────────

export type Pair = {
  asset: Address;
  quote: Address;
  kinds: number[];
  /** Pools taking orders now. */
  openPools: number;
  /** Highest fixed APR among priced open pools (0 when none). */
  bestApr: number;
  graduated: boolean;
};

/** Collateral/quote pairs on the chain, ones with open pools first, then by best APR. */
export function pairsOf(pools: PoolRow[], now: number, block: bigint): Pair[] {
  const m = new Map<string, Pair>();
  for (const p of pools) {
    const k = `${p.asset.toLowerCase()}/${p.quote.toLowerCase()}`;
    const x = m.get(k) ?? { asset: p.asset, quote: p.quote, kinds: [], openPools: 0, bestApr: 0, graduated: false };
    if (!x.kinds.includes(p.kind)) x.kinds.push(p.kind);
    const o = offerOf(p, { now, block });
    if (o.open) {
      x.openPools++;
      if (o.priced && o.apr > x.bestApr) x.bestApr = o.apr;
    }
    x.graduated ||= p.graduated;
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => Number(b.openPools > 0) - Number(a.openPools > 0) || b.bestApr - a.bestApr || Number(b.graduated) - Number(a.graduated));
}

/** The network's coin in token lists (lib/native NATIVE, the zero address); kept here so this file stays pure. */
const COIN: Address = "0x0000000000000000000000000000000000000000";

/**
 * The token selector rows for one side of the market list: every token that has a pair with open
 * pools on that side (every pair while nothing is open), each once, in pair order, and the network's coin (`COIN`,
 * HYPE / MON) right before its wrapped token (WHYPE / WMON) wherever that one appears. Nothing without pools appears.
 */
export function selectorTokens(pairs: Pick<Pair, "asset" | "quote" | "openPools">[], side: "asset" | "quote", wrappedNative?: string): Address[] {
  const offered = pairs.some((p) => p.openPools > 0) ? pairs.filter((p) => p.openPools > 0) : pairs;
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const p of offered) {
    const a = p[side];
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    if (wrappedNative && a.toLowerCase() === wrappedNative.toLowerCase()) out.push(COIN);
    out.push(a);
  }
  return out;
}

// ───────────────────────────── vaults ─────────────────────────────

export type VaultRole = "pegged" | "native-lend" | "usd-low" | "usd-high" | "other";

/**
 * Which blueprint §5 vault this is: rv<NATIVE>-Pegged lends the native coin into LST/native pools; rvUSD…-Low / -High
 * lend USD into native/USD pools at the lowest / highest traded buy-back price of the last maturity; rv<NATIVE>-Lend
 * (HyperEVM, no staked coin there) lends the native coin into USD/native pools. All are
 * lender-side only; a redemption may include collateral from repayments that did not happen.
 */
export function vaultRole(v: Pick<VaultRow, "address" | "strikeRule" | "symbol">, vaults?: { pegged?: string; usdLow?: string; usdHigh?: string; nativeLend?: string }): VaultRole {
  const a = v.address.toLowerCase();
  if (vaults?.pegged && a === vaults.pegged.toLowerCase()) return "pegged";
  // HyperEVM has no staked HYPE: its native-coin vault lends WHYPE to USDC borrowers (deployments vaults.nativeLend)
  if (vaults?.nativeLend && a === vaults.nativeLend.toLowerCase()) return "native-lend";
  if (vaults?.usdLow && a === vaults.usdLow.toLowerCase()) return "usd-low";
  if (vaults?.usdHigh && a === vaults.usdHigh.toLowerCase()) return "usd-high";
  if (/pegged/i.test(v.symbol)) return "pegged";
  if (/low/i.test(v.symbol)) return "usd-low";
  if (/high/i.test(v.symbol)) return "usd-high";
  return "other";
}

/** Quote value of `shares` at the vault's current NAV (shares × totalAssets / totalSupply, rounded down); 0 before any supply. */
export function vaultSharesValue(v: Pick<VaultRow, "totalAssets" | "totalSupply">, shares: bigint): bigint {
  return v.totalSupply > 0n ? (shares * v.totalAssets) / v.totalSupply : 0n;
}

// ───────────────────────────── portfolio ─────────────────────────────

export type BorrowPosition = {
  pool: PoolRow;
  /** Buy-back rights held (R units), including those locked in a roll-over. */
  units: bigint;
  /** Units locked in a pending roll-over. */
  locked: bigint;
  /** Units free to repay or roll over. */
  free: bigint;
  /** Quote to repay all free units. */
  repay: bigint;
  canRepay: boolean;
  canRollover: boolean;
  /** Maturity passed and the window is over: lenders kept the collateral (any auction surplus is claimable). */
  lapsed: boolean;
  claimable: boolean;
};

export type LendPosition = {
  pool: PoolRow;
  /** Lender units (C). */
  units: bigint;
  /** Quote paid if every borrower repays (units × buy-back). */
  ifRepaid: bigint;
  /** After close: estimated claim (pro-rata of what the pool holds). */
  claim?: { quote: bigint; asset: bigint };
  claimable: boolean;
};

export type Portfolio = {
  borrows: BorrowPosition[];
  lends: LendPosition[];
  /** Balances waiting in the core for Withdraw (fills, refunds, leftovers). */
  withdrawable: { token: Address; amount: bigint }[];
  vaults: { vault: VaultRow; me: VaultMe }[];
  /** Something needs the user: a repayment window is open, a claim or a withdrawal is waiting. */
  attention: number;
};

/** Pro-rata claim of `c` lender units in a closed pool (WindowLogic.claim, rounded down). */
export function claimEstimate(p: Pick<PoolRow, "quoteBal" | "assetBal">, c: bigint, cSupply: bigint): { quote: bigint; asset: bigint } {
  if (c === 0n || cSupply === 0n) return { quote: 0n, asset: 0n };
  return { quote: (c * p.quoteBal) / cSupply, asset: (c * p.assetBal) / cSupply };
}

/** Surplus an R holder claims in a closed pool (abandonment-auction premium, rounded down). */
export function surplusEstimate(p: Pick<PoolRow, "surplusBal">, r: bigint, rSupply: bigint): bigint {
  return r === 0n || rSupply === 0n ? 0n : (r * p.surplusBal) / rSupply;
}

export function summarizePortfolio(i: {
  pools: PoolRow[];
  positions: Record<string, Position> | undefined;
  supplies?: Record<string, { c: bigint; r: bigint }>;
  pending?: Record<string, bigint>;
  vaults?: { vault: VaultRow; me: VaultMe | undefined }[];
  now: number;
  block: bigint;
}): Portfolio {
  const borrows: BorrowPosition[] = [];
  const lends: LendPosition[] = [];
  for (const p of i.pools) {
    const pos = i.positions?.[p.id];
    if (!pos) continue;
    const closed = p.status === Status.Closed;
    if (pos.r > 0n) {
      const free = pos.r > pos.locked ? pos.r - pos.locked : 0n;
      const over = p.status === Status.Closing || closed || (p.status === Status.Window && !windowOpen(p, i.now, i.block));
      borrows.push({
        pool: p,
        units: pos.r,
        locked: pos.locked,
        free,
        repay: repayAmount(free, p.strike, scaleOf(p.assetDecimals)),
        canRepay: free > 0n && canRepay(p, i.now, i.block),
        canRollover: free > 0n && canRollover(p, i.now, i.block),
        lapsed: over,
        claimable: closed && free > 0n && surplusEstimate(p, free, i.supplies?.[p.id]?.r ?? 0n) > 0n,
      });
    }
    if (pos.c > 0n) {
      const supply = i.supplies?.[p.id]?.c;
      lends.push({
        pool: p,
        units: pos.c,
        ifRepaid: quoteDown(pos.c, p.strike, scaleOf(p.assetDecimals)),
        claim: closed && supply !== undefined ? claimEstimate(p, pos.c, supply) : undefined,
        claimable: closed,
      });
    }
  }
  const withdrawable = Object.entries(i.pending ?? {})
    .filter(([, v]) => v > 0n)
    .map(([token, amount]) => ({ token: token as Address, amount }));
  const vaults = (i.vaults ?? [])
    .filter((x): x is { vault: VaultRow; me: VaultMe } => !!x.me)
    .filter(({ me }) => me.shares > 0n || me.pendingDeposit > 0n || me.pendingRedeem > 0n || me.claimShares > 0n || me.claimAssets > 0n || me.assetCredits.length > 0);
  const attention =
    borrows.filter((b) => b.free > 0n && windowOpen(b.pool, i.now, i.block)).length +
    borrows.filter((b) => b.claimable).length +
    lends.filter((l) => l.claimable).length +
    withdrawable.length +
    vaults.filter(({ me }) => me.claimShares > 0n || me.claimAssets > 0n || me.assetCredits.length > 0).length;
  borrows.sort((a, b) => a.pool.expiry - b.pool.expiry);
  lends.sort((a, b) => a.pool.expiry - b.pool.expiry);
  return { borrows, lends, withdrawable, vaults, attention };
}
