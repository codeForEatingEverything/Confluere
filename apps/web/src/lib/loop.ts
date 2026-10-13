/**
 * Loop planner (blueprint 7.1): sell LST into an American pegged pool, receive the native coin, stake it into more
 * LST outside the protocol, repeat. Pure bigint, display only; staking happens in an external protocol and its
 * rate is the user's assumption.
 */
import { Kind, quoteDown, repayAmount } from "@confluere/sdk";
import { launchTokensOf } from "./chains";
import { isPegged } from "./markets";

/**
 * Markets a loop works in (IA v3.1 items 1 and 3), either repay style: the collateral is either the network's own
 * coin (WHYPE / WMON, which the person may pay as HYPE / MON) or a staked version of it (a pegged market). A staked
 * token is not required: on a network without one, the coin's market is the loop market.
 */
export function isLoopMarket(p: { kind: Kind; asset: string; bandBps: number }, chainId: number): boolean {
  // both repay styles: a loop borrows and re-posts at one maturity, it never needs to repay early (every
  // token pair's pools are listed, one to one)
  const w = launchTokensOf(chainId).native;
  return isPegged(p) || (!!w && w.toLowerCase() === p.asset.toLowerCase());
}

/**
 * The loop markets of a network, every one of them (the coin's own market and, where it exists, the staked coin's
 * pegged market such as shMON / WMON), pegged first so the router and lists lead with the staking loop.
 */
export function loopMarkets<P extends { kind: Kind; asset: string; bandBps: number }>(pools: P[], chainId: number): P[] {
  const all = pools.filter((p) => isLoopMarket(p, chainId));
  return [...all.filter(isPegged), ...all.filter((p) => !isPegged(p))];
}

export const RATE_ONE = 10n ** 18n;

export type LoopInput = {
  a0: bigint; // starting LST (asset base units)
  pStar: bigint; // assumed batch price, quote base units per 1 whole asset
  strike: bigint; // K, same units
  stakeRate: bigint; // LST received per 1 native coin, 1e18 fixed point
  rounds: number;
  assetDecimals: number;
  quoteDecimals: number;
};

export type LoopRound = { round: number; sell: bigint; borrowed: bigint; staked: bigint };

export type LoopPlan = {
  rounds: LoopRound[];
  borrowed: bigint; // Σ Q_i, native coin
  rUnits: bigint; // Σ L_i
  buyBack: bigint; // repayAmount(Σ L_i, K)
  hold: bigint; // L_{n+1}: LST held at the end
  exposure: bigint; // Σ L_1..L_{n+1}
  leverage: number; // exposure / a0
  cost: bigint; // buyBack − borrowed, native coin, per term
  breakEven: number; // cost / value of the exposure at P*, over the term
  worstLoss: bigint; // a0 − L_{n+1} if nothing is bought back
};

export function planLoop(i: LoopInput): LoopPlan {
  const scale = 10n ** BigInt(i.assetDecimals);
  const qScale = 10n ** BigInt(i.quoteDecimals);
  const n = Math.max(1, Math.min(5, Math.floor(i.rounds)));
  const rounds: LoopRound[] = [];
  let l = i.a0;
  for (let r = 1; r <= n; r++) {
    const q = quoteDown(l, i.pStar, scale);
    const next = (q * i.stakeRate * scale) / (RATE_ONE * qScale);
    rounds.push({ round: r, sell: l, borrowed: q, staked: next });
    l = next;
  }
  const borrowed = rounds.reduce((s, x) => s + x.borrowed, 0n);
  const rUnits = rounds.reduce((s, x) => s + x.sell, 0n);
  const hold = l;
  const exposure = rUnits + hold;
  const buyBack = repayAmount(rUnits, i.strike, scale);
  const cost = buyBack > borrowed ? buyBack - borrowed : 0n;
  const exposureValue = quoteDown(exposure, i.pStar, scale);
  return {
    rounds,
    borrowed,
    rUnits,
    buyBack,
    hold,
    exposure,
    leverage: i.a0 > 0n ? Number((exposure * 1_000_000n) / i.a0) / 1_000_000 : 0,
    cost,
    breakEven: exposureValue > 0n ? Number(cost) / Number(exposureValue) : 0,
    worstLoss: i.a0 > hold ? i.a0 - hold : 0n,
  };
}

export type StakeRateSource = "lst" | "reference" | "pstar";

/**
 * Default staking rate (LST per 1 native coin, 1e18 fixed point), most trustworthy source first:
 * 1. the LST's own ERC-4626 `convertToShares(1 native)` (`sharesPerNative`, asset base units);
 * 2. 1 / reference price (display-only off-chain price, native per LST);
 * 3. 1 / P*: in a pegged pool P* is the native price of one LST. This ignores the pool's discount, so it slightly
 *    overstates what staking returns, but it is the right order of magnitude (1 shMON ≈ 12.9 MON, not 1).
 */
export function defaultStakeRate(i: {
  sharesPerNative?: bigint | null;
  ref?: number | null;
  pStar: bigint;
  assetDecimals: number;
  quoteDecimals: number;
}): { rate: bigint; source: StakeRateSource } | undefined {
  if (i.sharesPerNative && i.sharesPerNative > 0n) return { rate: (i.sharesPerNative * RATE_ONE) / 10n ** BigInt(i.assetDecimals), source: "lst" };
  if (i.ref && i.ref > 0 && Number.isFinite(i.ref)) return { rate: BigInt(Math.round(1e18 / i.ref)), source: "reference" };
  if (i.pStar > 0n) return { rate: (RATE_ONE * 10n ** BigInt(i.quoteDecimals)) / i.pStar, source: "pstar" };
  return undefined;
}

/** Per-browser plan memory (`confluere.loop.{pool}`); progress itself is read from the chain (R balance). */
export type SavedLoop = { a0: string; rounds: number; pStar: string; stakeRate: string };
export const loopKey = (pool: string) => `confluere.loop.${pool.toLowerCase()}`;

export function saveLoop(pool: string, plan: SavedLoop) {
  try {
    localStorage.setItem(loopKey(pool), JSON.stringify(plan));
  } catch {}
}

export function readLoop(pool: string): SavedLoop | undefined {
  try {
    const v = localStorage.getItem(loopKey(pool));
    return v ? (JSON.parse(v) as SavedLoop) : undefined;
  } catch {
    return undefined;
  }
}

/** Rounds already sold, read from the chain: how many leading rounds the R balance covers (1% tolerance). */
export function loopProgress(plan: LoopPlan, rBalance: bigint): number {
  let acc = 0n;
  let k = 0;
  for (const r of plan.rounds) {
    acc += r.sell;
    if (rBalance * 100n >= acc * 99n) k++;
    else break;
  }
  return k;
}

/** Parse a saved plan back into planLoop input. */
export function savedToInput(s: SavedLoop, strike: bigint, assetDecimals: number, quoteDecimals: number): LoopInput {
  return { a0: BigInt(s.a0), pStar: BigInt(s.pStar), stakeRate: BigInt(s.stakeRate), rounds: s.rounds, strike, assetDecimals, quoteDecimals };
}
