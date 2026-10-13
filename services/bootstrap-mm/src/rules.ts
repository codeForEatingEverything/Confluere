/**
 * Bootstrap market making, blueprint section 4.2. Written down so anyone can check the bot against it:
 * - price = last clearing price moved toward the lender by a fixed spread: 0.5% (main) or 0.1% (pegged);
 * - quantity is capped per pool, per batch (PER_BATCH_QUOTE) and in total (TOTAL_QUOTE). The total counts quote
 *   actually paid for fills plus the escrow of bids still resting; escrow refunded by an unfilled bid does not count;
 * - only fills the gap: if competitive buy depth at or above that price already covers the batch amount, do nothing;
 * - exits for good after 8 weeks from its first start, once every market it quotes has a seat holder, or at END_AT
 *   if the operator set an earlier date.
 */
export type PoolClass = "pegged" | "main";

export const SPREAD_BPS: Record<PoolClass, bigint> = { pegged: 10n, main: 50n };

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
  const target = (budget * i.scale) / limit;
  if (i.competitiveDepthUnits >= target) return null;
  const units = target - i.competitiveDepthUnits;
  return units > 0n ? { limit, units } : null;
}

/** Quote a pool has used against its total cap: paid for fills, plus what its resting bids still escrow. */
export function committed(spent: bigint, openEscrows: bigint[]): bigint {
  return openEscrows.reduce((a, b) => a + b, spent);
}

/** Fixed run length from the first start (blueprint 4.2: "run for 8 weeks"). Not configurable on purpose. */
export const RUN_S = 8 * 7 * 86_400;

export type ExitInputs = { now: number; startedAt: number; endAt: number; marketsSeated: boolean[] };

/** Why the bot must stop now, or null to keep running. Exiting is permanent: the caller persists the reason. */
export function exitReason(i: ExitInputs): string | null {
  if (i.now >= i.startedAt + RUN_S) return "eight weeks elapsed";
  if (i.marketsSeated.length > 0 && i.marketsSeated.every(Boolean)) return "seats cover every market";
  if (i.endAt > 0 && i.now >= i.endAt) return "END_AT reached";
  return null;
}
