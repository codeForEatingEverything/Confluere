import { formatUnits, parseUnits } from "viem";

const THIN = " ";

/** Legacy compact formatter (kept for older call sites); new code uses fmtAmount / fmtPrice. */
export function fmt(v: bigint | undefined, decimals: number, digits = 4): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function numberText(n: number, minFrac = 0): string {
  const a = Math.abs(n);
  if (a === 0) return minFrac ? (0).toFixed(minFrac) : "0";
  if (a >= 1_000_000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: minFrac, maximumFractionDigits: Math.max(4, minFrac) });
  const s = n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  if (!minFrac) return s;
  const frac = s.split(".")[1]?.length ?? 0;
  return frac >= minFrac ? s : n.toFixed(minFrac);
}

/**
 * Token amount for display: >= 1,000,000 two decimals; >= 1 up to four decimals (trailing zeros dropped);
 * < 1 six significant digits. Thousands separators; the symbol follows after a thin space. Missing value: "—".
 */
export function fmtAmount(v: bigint | undefined | null, decimals: number, sym?: string): string {
  if (v === undefined || v === null) return "—";
  const t = numberText(Number(formatUnits(v, decimals)));
  return sym ? `${t}${THIN}${sym}` : t;
}

/** Price (quote per one asset): like fmtAmount but with at least two decimals (0.025 stays 0.025). */
export function fmtPrice(v: bigint | undefined | null, quoteDecimals: number, sym?: string): string {
  if (v === undefined || v === null) return "—";
  const t = numberText(Number(formatUnits(v, quoteDecimals)), 2);
  return sym ? `${t}${THIN}${sym}` : t;
}

/** Decimal string suitable for an input field (no separators, full precision). */
export const toInput = (v: bigint, decimals: number): string => formatUnits(v, decimals);

/** Parse a user-typed decimal; empty or malformed input reads as 0. */
export function parseAmount(v: string, decimals: number): bigint {
  try {
    const t = v.trim().replaceAll(",", "");
    return t ? parseUnits(t, decimals) : 0n;
  } catch {
    return 0n;
  }
}

export const pct = (x: number, digits = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "—");

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Countdown text; fractional seconds round up, so a deadline 599.9 s away still reads "10m 00s". */
export function duration(seconds: number): string {
  if (seconds <= 0) return "now";
  const s = Math.ceil(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Seconds a number of blocks takes at the measured `secPerBlock` (see useBlockTime); 0 when unknown. */
export const blocksToSeconds = (n: number, secPerBlock: number | null | undefined) => (secPerBlock && secPerBlock > 0 ? n * secPerBlock : 0);

/**
 * "300 blocks (≈ 4m 55s)". Blocks are the rule; the time is an estimate from the measured block time and is
 * left out when the block time is unknown (never assumed from WINDOW_BLOCKS).
 */
export function fmtBlocks(n: number | bigint, secPerBlock: number | null | undefined): string {
  const b = Number(n);
  const head = `${b.toLocaleString("en-US")} block${b === 1 ? "" : "s"}`;
  const s = blocksToSeconds(b, secPerBlock);
  return s > 0 ? `${head} (≈ ${duration(s)})` : head;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => n.toString().padStart(2, "0");

/** "Tue 13 Oct, 09:00 UTC" (FRONTEND_V3 §9: no middle dots). */
export function fmtExpiry(ts: number): string {
  const d = new Date(ts * 1000);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

/** "Tue 13 Oct, 09:00" for date chips (UTC, the zone is stated once nearby). */
export function fmtChip(ts: number): string {
  const d = new Date(ts * 1000);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** "Tue 13 Oct". */
export function fmtWeekday(ts: number): string {
  const d = new Date(ts * 1000);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** "11:00 UTC". */
export function fmtClock(ts: number): string {
  const d = new Date(ts * 1000);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

/** Waiting time in plain words, never second-precise above a minute: "30 s", "2 min", "2 h 5 min", "3 days 4 h". */
export function fmtWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${Math.max(10, Math.ceil(s / 10) * 10)} s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h ? `${d} day${d > 1 ? "s" : ""} ${h} h` : `${d} day${d > 1 ? "s" : ""}`;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return sec ? `${m} min ${sec} s` : `${m} min`;
}

/** Signed percentage for a return: "+0.67%". */
export const pctSigned = (x: number, digits = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%` : "—");

/** Short UTC date for tables: "17 Oct". */
export function fmtDay(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

/** Local time, for batch moments and tooltips. */
export const fmtLocal = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Legacy name kept for older call sites. */
export const dateTime = fmtLocal;

export const STATUS_LABEL = ["—", "Open", "Repayment window", "Closing", "Closed"];
export const KIND_LABEL = ["Repay any time", "Repay at maturity only"];
export const kindSlug = (k: number) => (k === 0 ? "american" : "european");

/** "every 30 min" / "every 6h" / "every 24h" from a batch interval in seconds. */
export function every(seconds: number): string {
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60} min`;
  return `every ${seconds}s`;
}

/** Native coin symbol per chain (gas token, and what "NATIVE" in vault names stands for). */
export function nativeSymbol(chainId: number): string {
  if (chainId === 143 || chainId === 10143) return "MON";
  if (chainId === 999 || chainId === 998) return "HYPE";
  return "ETH"; // Ethereum and Sepolia (11155111), anvil
}

/** Vault symbols say NATIVE; show the chain's coin instead (rvNATIVE-Pegged -> rvMON-Pegged). */
export function vaultDisplayName(symbol: string, chainId: number): string {
  if (chainId === 31337) return symbol;
  return symbol.replaceAll("NATIVE", nativeSymbol(chainId));
}

/** Annualised percentage with "if repaid" kept by the caller. */
export const apr = (x: number) => pct(x, 2);

/**
 * Amount of a token for the main path: dollar-like tokens (≤ 6 decimals) with two decimals, others with up to four
 * (FRONTEND_V3 §9). `sym` appends the symbol after a normal space.
 */
export function fmtToken(v: bigint | undefined | null, t: { decimals: number; symbol?: string } | undefined, withSymbol = true, opts: { compact?: boolean } = {}): string {
  if (v === undefined || v === null || !t) return "—";
  const n = Number(formatUnits(v, t.decimals));
  const a = Math.abs(n);
  const dollarLike = t.decimals <= 6;
  let s: string;
  if (opts.compact && a >= 1_000_000) s = n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  else if (a === 0) s = dollarLike ? "0.00" : "0";
  else if (a < 1)
    s = dollarLike
      ? a < 0.01
        ? "<0.01"
        : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : a < 0.000001
        ? "<0.000001"
        : n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  // four decimals only while they mean something: 5.668 HYPE, but 21,828.77 HYPE rather than 21,828.766
  else s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: dollarLike || a >= 1000 ? 2 : 4 });
  return withSymbol && t.symbol ? `${s} ${t.symbol}` : s;
}

/**
 * A price (quote per 1 whole collateral) with a fixed decimal count from its magnitude, trailing zeros kept, so two
 * different buy-back prices never print the same and a column lines up: 34.00 · 10.62 · 1.235 · 0.0250 · 0.0241.
 */
export function fmtPer(v: bigint | undefined | null, quote: { decimals: number } | undefined): string {
  if (v === undefined || v === null || !quote) return "—";
  const n = Number(formatUnits(v, quote.decimals));
  if (n === 0) return "0.00";
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const d = Math.min(quote.decimals, n < 1 ? Math.max(2, 2 - mag) : Math.max(2, 3 - mag));
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
