/**
 * The user vocabulary (FRONTEND_V3 §4): the only place screen words that depend on protocol state are produced.
 * Protocol names never leave this file as text; screens call these helpers.
 */
import type { VaultRow } from "./data";
import type { VaultRole } from "./product";
import { fmtPer } from "./format";

export const STYLE_LABEL = ["Repay any time", "Repay at maturity only"] as const;
export const STYLE_SHORT = ["Repay any time", "At maturity only"] as const;

/** Vault display names (§8.2): rvUSD…-Low → "USDC vault, cautious", -High → "higher yield", rv<NATIVE>-Pegged → "MON vault". */
export function vaultName(role: VaultRole, quoteSymbol: string, native: string): string {
  // the pegged vault lends the network's coin by definition (rv<NATIVE>-Pegged), like the Lending vault: both are named
  // after the coin (HYPE / MON) and drawn with its logo (`vaultIcon`); deposits take the coin or its wrapped token
  if (role === "pegged") return `${native} Pegged vault`;
  if (role === "native-lend") return `${native} Lending vault`;
  if (role === "usd-low") return `${quoteSymbol} Conservative vault`;
  if (role === "usd-high") return `${quoteSymbol} High-yield vault`;
  return `${quoteSymbol} vault`;
}

/** The vaults that lend the network's coin (rv<NATIVE>-Pegged, rv<NATIVE>-Lend): named, shown and paid in HYPE / MON. */
export const isCoinVault = (role: VaultRole) => role === "pegged" || role === "native-lend";

/**
 * The vault's money as the screens show it (list, drawer, Portfolio): for a coin vault the coin itself (zero address so
 * the icon is the HYPE / MON logo without the wrapped mark, the coin's symbol, the quote's decimals); else the quote
 * token unchanged. Writes keep using the quote token (WHYPE / WMON); WHYPE is shown only where the person picks it.
 */
export function vaultToken<T extends { address: string; symbol: string }>(role: VaultRole, quote: T | undefined, native: string): T | undefined {
  if (!quote || !isCoinVault(role)) return quote;
  return { ...quote, address: "0x0000000000000000000000000000000000000000", symbol: native };
}

/** The token a vault's icon shows, matching its name (see `vaultToken`). */
export function vaultIcon(role: VaultRole, quote: { address: string; symbol: string } | undefined, native: string): { address?: string; symbol?: string } {
  if (isCoinVault(role)) return { address: "0x0000000000000000000000000000000000000000", symbol: native };
  return { address: quote?.address, symbol: quote?.symbol };
}

/** What a vault lends, as named on screen: the coin for the vaults named after it, else the quote token. */
export const vaultLends = (role: VaultRole, quoteSymbol: string | undefined, native: string) => (isCoinVault(role) ? native : (quoteSymbol ?? "…"));

/** Which buy-back price the vault's fixed rule lends at. */
export const vaultLevel = (v: Pick<VaultRow, "strikeRule">) => (v.strikeRule === 0 ? "lower" : "higher");

/** One line under the vault name. Pegged vaults name the native coin and the staked token borrowers sell. */
export function vaultLine(role: VaultRole, v: Pick<VaultRow, "strikeRule">, quote: string, asset: string, native: string): string {
  if (role === "pegged") return `Lends ${native} to ${asset} borrowers`;
  if (role === "native-lend") return `Lends ${native} to ${asset} borrowers at the ${vaultLevel(v)} buy-back price`;
  return `Lends ${quote} to ${asset} borrowers at the ${vaultLevel(v)} buy-back price`;
}

/** The three fixed sentences at the top of the vault drawer (§8.3), word for word. */
export function vaultSentences(v: Pick<VaultRow, "strikeRule" | "capBps">, quote: string, asset: string): [string, string, string] {
  const cap = `${(v.capBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  return [
    `This vault lends ${quote} to borrowers who sold ${asset} into the market. It never buys or holds ${asset} on purpose.`,
    `If a borrower doesn't repay, their ${asset} is sold into the next maturity and the vault gets ${quote} back. You always withdraw in ${quote} only.`,
    `Rule, fixed at deployment: lend at the ${vaultLevel(v)} buy-back price, at most ${cap} of idle funds each round, only into established markets that sell unrepaid collateral. Nobody can change it.`,
  ];
}

/** "1 WHYPE per 34.00 USDC": what backs a lending position, per buy-back price. */
export const backedBy = (asset: string, buyBack: string, quote: string) => `1 ${asset} per ${buyBack} ${quote}`;

/** Network names as the switcher shows them: "HyperEVM Testnet", "Monad Testnet", "Sepolia Testnet", "Local (anvil)". */
export function networkName(m: { id: number; name: string; testnet: boolean }): string {
  if (m.id === 31337) return "Local (anvil)";
  return m.testnet ? `${m.name} Testnet` : m.name;
}

/** Where "Price now" comes from on this chain (display only, never sent to a contract). */
export function priceSource(chainId: number, asset: string, quote: string, o: { lst?: string; native?: string; assetSymbol?: string } = {}): string {
  const { lst, native } = o;
  const a = asset.toLowerCase();
  const q = quote.toLowerCase();
  if (lst && native && a === lst.toLowerCase() && q === native.toLowerCase()) return `${o.assetSymbol ?? "the staked token"}'s own rate`;
  if (chainId === 998 || chainId === 999) return "HyperCore spot";
  if (chainId === 10143 || chainId === 143) return "Kuru order book";
  // Sepolia has no market worth quoting: the reference is Ethereum mainnet's ETH / USD spot (lib/refPrice)
  if (chainId === 11155111 || chainId === 1) return "ETH / USD spot (mainnet)";
  return "reference feed";
}

/**
 * "How this vault works" (IA v3.1 item 4), in plain words: what it lends, where, where the return comes from, the worst
 * case, timing, what a withdrawal pays and the fees.
 */
export function vaultExplainer(v: Pick<VaultRow, "strikeRule" | "capBps">, quote: string, asset: string): { k: string; v: string }[] {
  const cap = `${(v.capBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  return [
    { k: "What it lends", v: `You deposit ${quote}. The vault lends it to people who borrow against ${asset}. It never buys ${asset} on purpose.` },
    { k: "Where it lends", v: `Only in established markets, ones that have already run cleanly for several terms. It lends at the ${vaultLevel(v)} buy-back price and puts at most ${cap} of its idle ${quote} into each round. The rule is written into the contract; nobody can change it.` },
    { k: "Where the return comes from", v: `Borrowers receive less ${quote} now than they pay back at maturity. When they buy their ${asset} back, that difference is the vault's fixed return.` },
    { k: "Worst case", v: `A borrower who doesn't buy back leaves their ${asset} to the vault at the agreed price. If ${asset} is then worth less than that price, the vault, and so you, carries the loss.` },
    { k: "When money moves", v: "Not instantly. Deposits are collected now and start lending at the next term; withdrawals are requested now and paid when the current term ends, first come first served." },
    { k: "What a withdrawal pays", v: `${quote}, plus any ${asset} the vault received from borrowers who didn't repay.` },
    { k: "Fees", v: "No management or performance fee. The protocol keeps a share only of interest that borrowers actually repay, and nothing when they don't." },
  ];
}

// ------------------------------------------------------------ position tokens (C / R)

/**
 * The two position tokens of a market, named once here (FRONTEND_V3 §4.2, Pendle PT / YT style). The contract calls them
 * C (id = poolId, the lender's side) and R (id = poolId | 1, the borrower's buy-back right); the screen never does.
 *
 * Named after the blueprint's C-Token and R-Token:
 * - C, "Lender token": pays the buy-back price at maturity if the
 *   borrower buys back, otherwise 1 unit of collateral. C matures.
 * - R, "Buy-back right": buys 1 unit of collateral for the buy-back price until the repayment window ends, worth
 *   nothing after. R expires.
 *
 * Symbol: {C|R}-{ASSET}-{DDMMM}[-{HHMM}], e.g. C-WHYPE-16OCT, short enough for cards and table cells; the buy-back
 * price and repay style are in the line under it. The time is added only when another maturity on this network falls
 * on the same UTC day.
 */
export type PositionKind = "ft" | "br";

export const POSITION: Record<PositionKind, { prefix: "C" | "R"; display: string; tab: string; verb: string }> = {
  ft: { prefix: "C", display: "Lender token", tab: "C · Lend", verb: "matures" },
  br: { prefix: "R", display: "Buy-back right", tab: "R · Buy-back", verb: "expires" },
};

type NamedPool = { expiry: number; strike: bigint; kind: number };
type NamedToken = { symbol: string; decimals: number };

const MON_UP = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const MON_LONG = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => n.toString().padStart(2, "0");
const utcDay = (ts: number) => Math.floor(ts / 86_400);

/** The buy-back price as a symbol shows it: fmtPer's digits without trailing zeros or thousands separators (34, 0.031, 2500). */
export function symbolPrice(price: bigint, quote: { decimals: number }): string {
  const s = fmtPer(price, quote).replace(/,/g, "");
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Whether another maturity in `all` falls on the same UTC day (then names carry the time too). */
const sharesDay = (expiry: number, all: readonly { expiry: number }[] = []) => all.some((p) => p.expiry !== expiry && utcDay(p.expiry) === utcDay(expiry));

/** "16OCT26", or "16OCT26-1400" when another maturity on this network falls on the same UTC day. */
export function maturityTag(pool: { expiry: number }, all: readonly { expiry: number }[] = []): string {
  const d = new Date(pool.expiry * 1000);
  const day = `${two(d.getUTCDate())}${MON_UP[d.getUTCMonth()]}${two(d.getUTCFullYear() % 100)}`;
  return sharesDay(pool.expiry, all) ? `${day}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}` : day;
}

/** "16 Oct 2026", with ", 14:00 UTC" when the day alone is ambiguous. */
function maturityDate(pool: { expiry: number }, all: readonly { expiry: number }[] = []): string {
  const d = new Date(pool.expiry * 1000);
  const day = `${d.getUTCDate()} ${MON_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return sharesDay(pool.expiry, all) ? `${day}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC` : day;
}

export type PositionName = {
  /** "C" / "R". */
  prefix: "C" | "R";
  /** Wallet and narrow columns: "C-WHYPE" (at most 11 characters). */
  short: string;
  /** Full symbol: "C-WHYPE-16OCT". */
  symbol: string;
  /** "Lender token" / "Buy-back right". */
  display: string;
  /** "HYPE / USDC · buy back at 34 · matures 16 Oct 2026". */
  line: string;
  /** The two letters on the icon. */
  badge: "C" | "R";
};

/** The one place a position token's name is made. `all` = the network's pools, to tell same-day maturities apart. */
export function positionName(t: PositionKind, pool: NamedPool, asset: NamedToken, quote: NamedToken, ctx: { all?: readonly { expiry: number }[] } = {}): PositionName {
  const prefix = POSITION[t].prefix;
  const a = asset.symbol.replace(/[^A-Za-z0-9.]/g, "");
  const symbol = `${prefix}-${a}-${maturityTag(pool, ctx.all).replace(/^(\d{2}[A-Z]{3})\d{2}/, "$1")}`;
  return { prefix, short: `${prefix}-${a.slice(0, 8)}`, symbol, display: POSITION[t].display, line: positionLine(pool, asset, quote, ctx), badge: prefix };
}

/** "HYPE / USDC · buy back at 34 · matures 16 Oct 2026". */
export function positionLine(pool: NamedPool, asset: NamedToken, quote: NamedToken, ctx: { all?: readonly { expiry: number }[] } = {}): string {
  return `${asset.symbol} / ${quote.symbol} · buy back at ${symbolPrice(pool.strike, quote)} · matures ${maturityDate(pool, ctx.all)}`;
}

/**
 * The one sentence that goes with a name. C: what it pays (`net` = the buy-back price less the protocol's share, when a
 * price exists). R: what it lets you do and until when (`until`, e.g. "Fri 16 Oct, 10:00 UTC").
 */
export function positionAbout(t: PositionKind, pool: NamedPool, asset: NamedToken, quote: NamedToken, o: { net?: bigint; until?: string } = {}): string {
  if (t === "ft") {
    const pays = o.net && o.net > 0n ? fmtPer(o.net, quote) : fmtPer(pool.strike, quote);
    return `Pays ${pays} ${quote.symbol} at maturity if the borrower buys back, otherwise 1 ${asset.symbol}.`;
  }
  const until = o.until ?? "the repayment window ends";
  const when = pool.kind === 1 ? `between maturity and ${until}` : `until ${until}`;
  return `Lets you buy 1 ${asset.symbol} for ${fmtPer(pool.strike, quote)} ${quote.symbol} ${when}. Worth nothing after.`;
}

/** How C and R relate (an explanation, not an action: the contract has no merge). */
export const pairNote = (asset: string) => `Together, 1 C and 1 R come to 1 ${asset} at maturity, less the protocol's share of repaid interest.`;

/** The collateral price above which holding R pays off: buy-back price + what the R cost. */
export const breakEven = (buyBackPrice: bigint, brPrice: bigint): bigint => buyBackPrice + brPrice;
