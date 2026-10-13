/**
 * Native twins: every list shows BOTH the network's coin and its wrapped token as separate
 * pairings. On chain the pools, vaults and LP slots hold only the wrapped coin (WHYPE / WMON), so each row that touches
 * it appears twice:
 *
 * - `via: "native"`, the twin, right before it: named with the coin ("HYPE / USDC", HYPE logo). It opens the same pool
 *   with Pay with preset to the coin (`?pay=native`); the wrap is a step inside the same button.
 * - `via: "wrapped"`, the row as on chain ("WHYPE / USDC", logo with the small W mark). It opens with `?pay=wrapped`:
 *   pays and receives WHYPE directly, nothing is unwrapped.
 *
 * Rows that do not touch the wrapped coin appear once (`via: "wrapped"`, `twin: false`, no pay preset). Pure: the
 * count tests (test/twins.test.ts) run it on live and demo fixtures.
 */
export type Via = "native" | "wrapped";
export type Twinned<T> = T & { via: Via; twin: boolean };

/** The coin's address in token lists (lib/native NATIVE); repeated so this file stays pure. */
const COIN = "0x0000000000000000000000000000000000000000";

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Each row as on chain, and before every row touching `wrapped` its native twin. */
export function withTwins<T extends object>(rows: readonly T[], wrapped: string | undefined, tokensOf: (r: T) => string[]): Twinned<T>[] {
  const out: Twinned<T>[] = [];
  for (const r of rows) {
    const twin = !!wrapped && tokensOf(r).some((a) => same(a, wrapped));
    if (twin) out.push({ ...r, via: "native", twin });
    out.push({ ...r, via: "wrapped", twin });
  }
  return out;
}

/** Pools (or markets, pairs, LP slots): a twin when the collateral or the loan token is the wrapped coin. */
export const poolTwins = <T extends { asset: string; quote: string }>(rows: readonly T[], wrapped: string | undefined) => withTwins(rows, wrapped, (r) => [r.asset, r.quote]);

/** Vaults: a twin when the deposit token is the wrapped coin (USDC vaults appear once). */
export const vaultTwins = <T extends { quote: string }>(rows: readonly T[], wrapped: string | undefined) => withTwins(rows, wrapped, (r) => [r.quote]);

/** Stable React key: the on-chain id plus the pairing. */
export const twinKey = (id: string, via: Via | undefined) => `${id.toLowerCase()}:${via ?? "wrapped"}`;

/** The `?pay=` preset a row opens with: only rows that touch the wrapped coin carry one. */
export const payOf = (r: { via?: Via; twin?: boolean } | undefined): Via | undefined => (r?.twin ? r.via : undefined);

/** Reads `?pay=`: "native" | "wrapped" | undefined. */
export const parsePay = (v: string | null | undefined): Via | undefined => (v === "native" || v === "wrapped" ? v : undefined);

/**
 * A token as a row shows it: on a native row the wrapped coin is the coin (zero address, HYPE / MON, its plain logo);
 * everywhere else the token as on chain.
 */
export function shownToken<T extends { address: string; symbol: string }>(t: T | undefined, address: string, via: Via | undefined, wrapped: string | undefined, coin: string): { address: string; symbol: string | undefined; native: boolean } {
  if (via === "native" && same(address, wrapped)) return { address: COIN, symbol: coin, native: true };
  return { address, symbol: t?.symbol, native: false };
}

/** "HYPE / USDC" or "WHYPE / USDC" for a pool-like row. */
export function pairName(tokens: Record<string, { address: string; symbol: string }> | undefined, r: { asset: string; quote: string; via?: Via }, wrapped: string | undefined, coin: string, sep = " / "): string {
  const t = (a: string) => tokens?.[a.toLowerCase()];
  const a = shownToken(t(r.asset), r.asset, r.via, wrapped, coin).symbol ?? "…";
  const q = shownToken(t(r.quote), r.quote, r.via, wrapped, coin).symbol ?? "…";
  return `${a}${sep}${q}`;
}

/** Pair filter key: the on-chain pair plus the pairing ("all" matches everything). */
export const pairKey = (r: { asset: string; quote: string; via?: Via }) => `${r.asset}/${r.quote}/${r.via ?? "wrapped"}`.toLowerCase();
