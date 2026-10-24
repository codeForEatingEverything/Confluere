/**
 * Bootstrap market making, blueprint section 4.2. Written down so anyone can check the bot against it:
 * - price = last clearing price moved toward the lender by a fixed spread: 0.5% (main) or 0.1% (pegged);
 * - quantity is capped per pool, per batch (PER_BATCH_QUOTE) and in total (TOTAL_QUOTE). The total counts quote
 *   actually paid for fills plus the escrow of bids still resting; escrow refunded by an unfilled bid does not count;
 * - only fills the gap: if competitive buy depth at or above that price already covers the batch amount, do nothing;
 * - stops quoting a market for good once it has a seat holder or its weekly volume reached EXIT_WEEKLY_VOLUME (a
 *   deploy parameter, blueprint 13 q3); exits when every market it quotes is done, or at END_AT (v0.8: no fixed
 *   8-week run any more);
 * - the buyer's trade fee (0.015%) is paid out of the same budget: units are sized so cost + fee fits it.
 */
export type PoolClass = "pegged" | "main";

export const SPREAD_BPS: Record<PoolClass, bigint> = { pegged: 10n, main: 50n };

export const isPoolClass = (s: string): s is PoolClass => Object.hasOwn(SPREAD_BPS, s);

/**
 * Band of a market named "poolId:auto" in POOLS (a bare poolId is main): a liquid staking token lent against its own
 * native coin is pegged (shMON / WMON on Monad, wstETH / WETH on Sepolia: `pools.lst` / `pools.native` of the
 * deployment); every other pair is main (WETH / USDC and wstETH / USDC on Sepolia, WMON / USDC, USDC / WHYPE). A deployment without an LST
 * (HyperEVM testnet, lst = 0) has no pegged market.
 */
export function classOf(asset: string, quote: string, pair?: { lst: string; native: string }): PoolClass {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!pair || /^0x0{40}$/i.test(pair.lst)) return "main";
  return eq(asset, pair.lst) && eq(quote, pair.native) ? "pegged" : "main";
}

export type Inputs = {
  cls: PoolClass;
  lastClearingPrice: bigint; // 0 = no reference yet
  scale: bigint; // 10 ** assetDecimals
  perBatchQuote: bigint;
  remainingQuote: bigint;
  competitiveDepthUnits: bigint; // buy units already resting at >= our limit
  now: number;
  endAt: number;
};

export type Quote = { limit: bigint; units: bigint } | null;

export function quote(i: Inputs): Quote {
  if (i.endAt > 0 && i.now >= i.endAt) return null;
  if (i.lastClearingPrice === 0n || i.remainingQuote === 0n) return null;
  const limit = (i.lastClearingPrice * (10_000n - SPREAD_BPS[i.cls])) / 10_000n;
  if (limit === 0n) return null;
  const budget = i.perBatchQuote < i.remainingQuote ? i.perBatchQuote : i.remainingQuote;
  // budget covers cost + the buyer's 0.015% trade fee (SDK TRADE_FEE_PPM)
  const target = ((budget * 1_000_000n) / 1_000_150n * i.scale) / limit;
  if (i.competitiveDepthUnits >= target) return null;
  const units = target - i.competitiveDepthUnits;
  return units > 0n ? { limit, units } : null;
}

/** Quote a pool has used against its total cap: paid for fills, plus what its resting bids still escrow. */
export function committed(spent: bigint, openEscrows: bigint[]): bigint {
  return openEscrows.reduce((a, b) => a + b, spent);
}

/** One market the bot quotes: whether a seat holder took it and its quote volume over the last week. */
export type MarketExit = { seated: boolean; weeklyVolume: bigint };

/** A market is done (never quoted again) once seated or once its weekly volume reached the exit line (0 = no line). */
export const marketDone = (m: MarketExit, exitWeeklyVolume: bigint): boolean =>
  m.seated || (exitWeeklyVolume > 0n && m.weeklyVolume >= exitWeeklyVolume);

export type ExitInputs = { now: number; endAt: number; markets: MarketExit[]; exitWeeklyVolume: bigint };

/** Why the bot must stop now, or null to keep running. Exiting is permanent: the caller persists the reason. */
export function exitReason(i: ExitInputs): string | null {
  if (i.markets.length > 0 && i.markets.every((m) => marketDone(m, i.exitWeeklyVolume))) {
    return i.markets.every((m) => m.seated) ? "seats cover every market" : "every market seated or past the weekly volume line";
  }
  if (i.endAt > 0 && i.now >= i.endAt) return "END_AT reached";
  return null;
}
