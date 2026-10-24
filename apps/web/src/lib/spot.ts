/**
 * Mainnet spot prices for chains whose own markets are not worth quoting (Sepolia), display only. Pure parsers for the
 * two public sources /api/ref/spot asks, in order: Coinbase's spot price, then Kraken's last trade. Neither needs a key.
 */

/** Pairs the route serves: `<BASE>_<QUOTE>` as the client asks for them, mapped to each source's own pair name. */
export const SPOT_PAIRS: Record<string, { coinbase: string; kraken: string }> = {
  ETH_USD: { coinbase: "ETH-USD", kraken: "ETHUSD" },
};

const positive = (x: unknown): number | null => {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Coinbase `GET /v2/prices/<pair>/spot` -> `{ data: { amount: "2379.84" } }`. */
export function coinbaseSpot(j: unknown): number | null {
  return positive((j as { data?: { amount?: unknown } } | null)?.data?.amount);
}

/** Kraken `GET /0/public/Ticker?pair=<pair>` -> `{ error: [], result: { XETHZUSD: { c: ["2380.06", vol] } } }` (last trade). */
export function krakenLast(j: unknown): number | null {
  const r = j as { error?: unknown[]; result?: Record<string, { c?: unknown[] }> } | null;
  if (!r?.result || (r.error && r.error.length > 0)) return null;
  const first = Object.values(r.result)[0];
  return positive(first?.c?.[0]);
}
