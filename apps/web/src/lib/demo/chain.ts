/**
 * The demo's sample network (IA v3.1 item 13). A small in-browser model of the Confluere contracts on HyperEVM and
 * Monad: tokens and balances, pools with their rounds, order books, buy-back rights and lender units, the repayment
 * window, vaults and LP seats. The demo client (lib/demo/client) answers the app's contract reads from it, and the
 * demo transaction path (lib/tx) applies each write to it after the wallet signs a plain message.
 *
 * - Every pool has weeks of past rounds (up to thirty days, generated from a fixed seed when the session starts, so a
 *   reload or another session looks the same): a fixed rate that wanders around its market's level with jumps, fills
 *   of varied size, busier and quieter days, and a market that has grown over the month. They are regenerated on
 *   reload, never stored.
 * - The clock is the wall clock. One round runs every minute: open pools trade (sample traders fill at random, and
 *   your orders fill when they cross), books refill on both sides, maturities open their repayment window, windows
 *   close, vaults roll.
 * - Reference prices take a small random step every five seconds (now and then a jump); rates follow the collateral
 *   and trades move a pool's price a little.
 * - Any wallet the app sees for the first time gets a starting set of balances and positions, so Portfolio has open
 *   loans, lending, a matured position to collect, an order, a balance to withdraw, vault shares and an LP seat.
 * - Everything else (what you do, the rounds since the session started) is kept in sessionStorage for the session.
 *
 * Nothing here talks to a chain. Words in this file follow the contracts; the screens keep their own vocabulary.
 */
import { ContractFunctionRevertedError, encodeErrorResult, parseAbi, zeroAddress, type Abi, type Address, type Hex } from "viem";
import {
  Kind,
  Side,
  Status,
  confluereAbi,
  cTokenId,
  deployments,
  erc6909WrapperAbi,
  marketId,
  poolId,
  quoteDown,
  quoteUp,
  repayAmount,
  rTokenId,
  scaleOf,
  seatRegistryAbi,
  spreadFee,
  buyEscrow,
  vaultAbi,
  isGridStrike,
} from "@confluere/sdk";
import { DEMO_ADDR, DEMO_GRID, demoDeploymentOf } from "./deployments";
import { buyCost, sellOut, sellPrice } from "./sell";

type B = bigint;
const YEAR = 365 * 86_400;
const HOUR = 3600;
const DAY = 86_400;
const lc = (a: string) => a.toLowerCase();
const now = () => Math.floor(Date.now() / 1000);

// ───────────────────────────── sample network specs ─────────────────────────────

type TokenSpec = { address: Address; symbol: string; decimals: number; lst?: { native: Address; rate: number } };
type MarketSpec = {
  asset: Address;
  quote: Address;
  kind: Kind;
  band: number;
  fee: number;
  graduated: boolean;
  /** Buy-back prices in quote tokens. */
  strikes: number[];
  /** Maturities, in grid days from the first one after the session starts. */
  days: number[];
  ref: string;
  /** Size of a sample trade, collateral units. */
  size: [number, number];
  pegged: boolean;
  activity: number;
  /** Extra pools: one in its repayment window, one closed (strike indices). */
  window?: number;
  closed?: number;
  /** "user" = the first wallet that connects holds it; a number = a sample holder; undefined = vacant. */
  seat?: "user" | number;
  seatPrice?: number;
};
type VaultSpec = { address: Address; name: string; symbol: string; quote: Address; market: number; tier: "low" | "high" | "any"; tvl: number; apr: number; strikeRule: number };
type UserPlan = {
  native: number;
  tokens: [Address, number][];
  loans: { m: number; at: number | "window"; s: number; units: number }[];
  lends: { m: number; at: number | "closed"; s: number; units: number }[];
  order: { m: number; at: number; s: number; units: number; below: number };
  pending: [Address, number];
  vaults: { v: number; shares: number; collect?: number; queued?: number }[];
};
type ChainSpec = {
  id: number;
  /** Markets of the sample set (markets opened in the demo come after them). */
  base?: number;
  spb: number;
  b0: number;
  tokens: TokenSpec[];
  /**
   * Reference prices (display only). `inverse` = this pair is 1 / that pair (USDC / WHYPE follows WHYPE / USDC);
   * `product` = this pair is the product of two pairs (kHYPE / USDC = kHYPE / WHYPE × WHYPE / USDC).
   */
  refs: Record<string, { p: number; vol: number; native?: boolean; inverse?: string; product?: [string, string] }>;
  markets: MarketSpec[];
  vaults: VaultSpec[];
  obligation: Record<string, number>;
  minNotional: Record<string, number>;
  graduationVolume: Record<string, number>;
  user: UserPlan;
};

const T0 = 1_790_000_000;

function specOf(chainId: number): ChainSpec | undefined {
  const d = demoDeploymentOf(chainId);
  if (!d?.pools) return undefined;
  const native = d.pools.native;
  const usdc = d.pools.usdc;
  const lst = d.pools.lst;
  if (chainId === 998) {
    return {
      id: 998,
      spb: 1,
      b0: 66_000_000,
      tokens: [
        { address: native, symbol: "WHYPE", decimals: 18 },
        { address: usdc, symbol: "USDC", decimals: 6 },
        { address: lst, symbol: "kHYPE", decimals: 18, lst: { native, rate: 1.0185 } },
      ],
      refs: {
        "WHYPE/USDC": { p: 38.42, vol: 0.0065 },
        "kHYPE/WHYPE": { p: 1.0185, vol: 0.0002 },
        "USDC/WHYPE": { p: 1 / 38.42, vol: 0.0065, inverse: "WHYPE/USDC" },
        "kHYPE/USDC": { p: 38.42 * 1.0185, vol: 0.0065, product: ["kHYPE/WHYPE", "WHYPE/USDC"] },
      },
      markets: [
        { asset: native, quote: usdc, kind: Kind.American, band: 800, fee: 1000, graduated: true, strikes: [28, 32, 36], days: [1, 3, 7, 14, 28], ref: "WHYPE/USDC", size: [4, 140], pegged: false, activity: 1, window: 2, closed: 1, seat: 0, seatPrice: 28_000 },
        { asset: native, quote: usdc, kind: Kind.European, band: 800, fee: 1000, graduated: true, strikes: [30, 34], days: [7, 28], ref: "WHYPE/USDC", size: [3, 90], pegged: false, activity: 0.75, seat: "user", seatPrice: 14_500 },
        { asset: lst, quote: native, kind: Kind.American, band: 150, fee: 1000, graduated: true, strikes: [0.97, 1], days: [3, 7, 14], ref: "kHYPE/WHYPE", size: [5, 90], pegged: true, activity: 0.85, seat: 4, seatPrice: 420 },
        // HYPE lending: borrowers post USDC and receive WHYPE (the HYPE Lending vault lends here)
        { asset: usdc, quote: native, kind: Kind.American, band: 800, fee: 1000, graduated: true, strikes: [0.021, 0.023], days: [3, 7, 14], ref: "USDC/WHYPE", size: [150, 6_000], pegged: false, activity: 0.8, seat: 2, seatPrice: 380 },
        { asset: usdc, quote: native, kind: Kind.European, band: 800, fee: 1000, graduated: false, strikes: [0.022], days: [7, 28], ref: "USDC/WHYPE", size: [100, 3_000], pegged: false, activity: 0.6 },
        // staked HYPE against USDC (every pair of the network's tokens has a market): buy-back prices ~87% and ~92% of kHYPE's value
        { asset: lst, quote: usdc, kind: Kind.American, band: 800, fee: 1000, graduated: true, strikes: [34, 36], days: [3, 7, 14, 28], ref: "kHYPE/USDC", size: [3, 110], pegged: false, activity: 0.75, seat: 5, seatPrice: 9_500 },
        { asset: lst, quote: usdc, kind: Kind.European, band: 800, fee: 1000, graduated: true, strikes: [34, 36], days: [7, 28], ref: "kHYPE/USDC", size: [2, 70], pegged: false, activity: 0.55, seat: 3, seatPrice: 6_200 },
      ],
      vaults: [
        { address: d.vaults!.usdLow, name: "Confluere USDC Low", symbol: "rvUSDC-Low", quote: usdc, market: 0, tier: "low", tvl: 2_350_000, apr: 0.071, strikeRule: 0 },
        { address: d.vaults!.usdHigh!, name: "Confluere USDC High", symbol: "rvUSDC-High", quote: usdc, market: 0, tier: "high", tvl: 1_180_000, apr: 0.118, strikeRule: 1 },
        { address: d.vaults!.pegged, name: "Confluere HYPE Pegged", symbol: "rvHYPE-Pegged", quote: native, market: 2, tier: "any", tvl: 58_000, apr: 0.043, strikeRule: 2 },
        { address: d.vaults!.nativeLend!, name: "Confluere HYPE Lend", symbol: "rvHYPE-Lend", quote: native, market: 3, tier: "low", tvl: 19_500, apr: 0.064, strikeRule: 0 },
      ],
      obligation: { [lc(usdc)]: 400, [lc(native)]: 12 },
      minNotional: { [lc(usdc)]: 10, [lc(native)]: 0.25 },
      graduationVolume: { [lc(usdc)]: 25_000, [lc(native)]: 600 },
      user: {
        native: 120,
        tokens: [[native, 30], [usdc, 18_500], [lst, 45]],
        loans: [{ m: 0, at: 7, s: 1, units: 12 }, { m: 0, at: "window", s: 2, units: 4.5 }, { m: 2, at: 7, s: 1, units: 20 }],
        lends: [{ m: 0, at: 14, s: 0, units: 40 }, { m: 0, at: "closed", s: 1, units: 25 }, { m: 3, at: 7, s: 0, units: 1_500 }],
        order: { m: 0, at: 3, s: 1, units: 10, below: 0.035 },
        pending: [usdc, 214.37],
        vaults: [{ v: 0, shares: 2_500, collect: 350 }, { v: 1, shares: 600, queued: 800 }, { v: 3, shares: 25 }],
      },
    };
  }
  if (chainId === 10143) {
    return {
      id: 10143,
      spb: 0.4,
      b0: 70_000_000,
      tokens: [
        { address: native, symbol: "WMON", decimals: 18 },
        { address: usdc, symbol: "USDC", decimals: 6 },
        { address: lst, symbol: "shMON", decimals: 18, lst: { native, rate: 1.0312 } },
      ],
      refs: {
        "WMON/USDC": { p: 0.02461, vol: 0.0085 },
        "shMON/WMON": { p: 1.0312, vol: 0.0002 },
        "shMON/USDC": { p: 0.02461 * 1.0312, vol: 0.0085, product: ["shMON/WMON", "WMON/USDC"] },
      },
      markets: [
        { asset: native, quote: usdc, kind: Kind.American, band: 800, fee: 1000, graduated: true, strikes: [0.018, 0.02, 0.022], days: [1, 3, 7, 14, 28], ref: "WMON/USDC", size: [20_000, 650_000], pegged: false, activity: 1, window: 2, closed: 1, seat: 1, seatPrice: 22_000 },
        { asset: native, quote: usdc, kind: Kind.European, band: 800, fee: 1000, graduated: true, strikes: [0.019, 0.021], days: [7, 28], ref: "WMON/USDC", size: [15_000, 400_000], pegged: false, activity: 0.7, seat: "user", seatPrice: 12_000 },
        { asset: lst, quote: native, kind: Kind.American, band: 150, fee: 1000, graduated: true, strikes: [0.98, 1], days: [3, 7, 14, 28], ref: "shMON/WMON", size: [2_000, 70_000], pegged: true, activity: 0.85, seat: 2, seatPrice: 680_000 },
        { asset: lst, quote: native, kind: Kind.European, band: 150, fee: 1000, graduated: false, strikes: [1], days: [14], ref: "shMON/WMON", size: [1_000, 20_000], pegged: true, activity: 0.55 },
        // staked MON against USDC: buy-back prices ~87% and ~91% of shMON's value
        { asset: lst, quote: usdc, kind: Kind.American, band: 800, fee: 1000, graduated: true, strikes: [0.022, 0.023], days: [3, 7, 14, 28], ref: "shMON/USDC", size: [15_000, 500_000], pegged: false, activity: 0.75, seat: 4, seatPrice: 8_800 },
        { asset: lst, quote: usdc, kind: Kind.European, band: 800, fee: 1000, graduated: true, strikes: [0.022, 0.023], days: [7, 28], ref: "shMON/USDC", size: [10_000, 300_000], pegged: false, activity: 0.55, seat: 0, seatPrice: 5_400 },
      ],
      vaults: [
        { address: d.vaults!.pegged, name: "Confluere MON Pegged", symbol: "rvMON-Pegged", quote: native, market: 2, tier: "any", tvl: 64_000_000, apr: 0.046, strikeRule: 2 },
        { address: d.vaults!.usdHigh!, name: "Confluere USDC High", symbol: "rvUSDC-High", quote: usdc, market: 0, tier: "high", tvl: 640_000, apr: 0.126, strikeRule: 1 },
        { address: d.vaults!.usdLow, name: "Confluere USDC Low", symbol: "rvUSDC-Low", quote: usdc, market: 0, tier: "low", tvl: 1_720_000, apr: 0.074, strikeRule: 0 },
      ],
      obligation: { [lc(usdc)]: 300, [lc(native)]: 12_000 },
      minNotional: { [lc(usdc)]: 10, [lc(native)]: 400 },
      graduationVolume: { [lc(usdc)]: 25_000, [lc(native)]: 1_000_000 },
      user: {
        native: 4_000,
        tokens: [[native, 1_500], [usdc, 12_000], [lst, 2_200]],
        loans: [{ m: 0, at: 7, s: 1, units: 18_000 }, { m: 0, at: "window", s: 2, units: 6_000 }, { m: 2, at: 7, s: 1, units: 800 }],
        lends: [{ m: 0, at: 14, s: 0, units: 50_000 }, { m: 0, at: "closed", s: 1, units: 30_000 }],
        order: { m: 0, at: 3, s: 1, units: 20_000, below: 0.035 },
        pending: [usdc, 96.12],
        vaults: [{ v: 2, shares: 1_800, collect: 240 }, { v: 0, shares: 2_000 }],
      },
    };
  }
  return undefined;
}

/** The account that holds the sample positions until a wallet connects (never shown). */
export const DEMO_ACCOUNT: Address = "0xd3a00000000000000000000000000000000de001";

// ───────────────────────────── state ─────────────────────────────

export type Row = { index: number; price: B; units: B; nc: B; block: number };

type PoolS = {
  id: Hex;
  asset: Address;
  quote: Address;
  expiry: number;
  strike: B;
  kind: number;
  m: number;
  tier: number;
  assetDecimals: number;
  feeBps: number;
  bandBps: number;
  status: number;
  settleCount: number;
  windowEnd: B;
  lastPrice: B;
  vwapNum: B;
  vwapDen: B;
  quoteBal: B;
  assetBal: B;
  volume: B;
  /** Rate noise (APR points) and the price premium around fair value (log), both mean-reverting. */
  noise: number;
  z: number;
  minFill: B;
  firstLo: B;
  firstHi: B;
  cadence: number;
  createdBlock: number;
  generated: boolean;
  special?: "window" | "closed";
  rows: Row[];
};

type OrderS = {
  pool: Hex;
  id: number;
  owner: Address;
  side: number;
  units: B;
  limit: B;
  escrow: B;
  budget: B;
  deadline: number;
  block: number;
  synthetic?: boolean;
  locked?: boolean;
  rollFrom?: Hex;
};

type SeatS = { holder: Address; price: B; deposit: B; bond: B; lastTax: number; priceLockedUntil: number; lastQuotedBatch: number };

type VaultAcct = { pendingDeposit: B; claimableDeposit: B; pendingRedeem: B; claimableRedeem: B; shares: B; claimShares: B; claimAssets: B; credits: Record<string, B> };
type VaultS = {
  address: Address;
  name: string;
  symbol: string;
  quote: Address;
  assets: Address[];
  kind: number;
  strikeRule: number;
  epoch: number;
  targetExpiry: number;
  ta: B;
  t0: number;
  apr: number;
  supply: B;
  pendingDepositAssets: B;
  pendingRedeemShares: B;
  lastPokeBatch: number;
  market: number;
  tier: "low" | "high" | "any";
  accts: Record<string, VaultAcct>;
};

type ChainState = {
  v: 4;
  chainId: number;
  seed: number;
  s0: number;
  refs: Record<string, number>;
  refs0: Record<string, number>;
  lastDrift: number;
  round: number;
  pools: Record<string, PoolS>;
  orders: OrderS[];
  nextOrderId: number;
  erc20: Record<string, B>;
  native: Record<string, B>;
  allowance: Record<string, B>;
  b6909: Record<string, B>;
  supply6909: Record<string, B>;
  lockedR: Record<string, B>;
  pending: Record<string, B>;
  operators: Record<string, boolean>;
  graduated: Record<string, boolean>;
  marketFees: Record<string, B>;
  feesSplit: Record<string, B>;
  seats: Record<string, SeatS>;
  seatClaimable: Record<string, B>;
  vaults: Record<string, VaultS>;
  wrappers: Record<string, Address>;
  wrapped: Record<string, B>;
  expiryWindowEnd: Record<string, B>;
  adopted: string[];
  seatGiven: boolean;
  extraMarkets: MarketSpec[];
};

// ───────────────────────────── random ─────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => {
  const u = Math.max(1e-9, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
};
const hashStr = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);

/** Sample traders: stable made-up addresses. */
const SYN: Address[] = Array.from({ length: 48 }, (_, i) => {
  const r = rng(9001 + i);
  return `0x${Array.from({ length: 40 }, () => Math.floor(r() * 16).toString(16)).join("")}` as Address;
});

// ───────────────────────────── units ─────────────────────────────

const toUnits = (x: number, dec: number): B => {
  if (!Number.isFinite(x) || x <= 0) return 0n;
  if (dec >= 6) return BigInt(Math.round(x * 1e6)) * 10n ** BigInt(dec - 6);
  return BigInt(Math.round(x * 10 ** dec));
};
const fromUnits = (v: B, dec: number) => Number(v) / 10 ** dec;
/** A price in quote base units, rounded down (a price never rounds up to the buy-back price). */
const priceUnits = (x: number, dec: number): B => (Number.isFinite(x) && x > 0 ? BigInt(Math.floor(x * 10 ** Math.min(dec, 12))) * 10n ** BigInt(Math.max(0, dec - 12)) : 0n);
const mulF = (v: B, f: number): B => (v * BigInt(Math.round(f * 1e9))) / 1_000_000_000n;

// ───────────────────────────── clock ─────────────────────────────

const blockAt = (spec: ChainSpec, t: number) => spec.b0 + Math.floor((t - T0) / spec.spb);
const timeAt = (spec: ChainSpec, b: number) => T0 + (b - spec.b0) * spec.spb;
const iv = DEMO_GRID.batchInterval;
const batchAt = (t: number) => Math.floor((t - DEMO_GRID.anchor) / iv);
const nextGrid = (t: number) => DEMO_GRID.anchor + Math.ceil((t - DEMO_GRID.anchor) / DEMO_GRID.period) * DEMO_GRID.period;
/** The soonest sample maturity: the first daily 08:00 UTC at least 16 hours after the session starts, so the home
 * card's default term shows a real rate rather than the last hours of a loan. */
const firstMaturity = (s0: number) => nextGrid(s0 + 16 * HOUR);

// ───────────────────────────── registry ─────────────────────────────

type Net = { spec: ChainSpec; st: ChainState; history: Map<string, Row[]>; tokens: Map<string, TokenSpec>; save: () => void };
const nets = new Map<number, Net>();
const listeners = new Set<(chainId: number, kind: "round" | "write") => void>();

/** Called after a round runs or a write lands (the demo provider refreshes the screens). */
export function onDemoChange(f: (chainId: number, kind: "round" | "write") => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}
const emit = (chainId: number, kind: "round" | "write") => listeners.forEach((f) => f(chainId, kind));

const STORE = (id: number) => `confluere.demo.net.${id}.v5`;

const ser = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $b: x.toString() } : x));
const de = <T>(s: string): T => JSON.parse(s, (_, x) => (x && typeof x === "object" && typeof x.$b === "string" && Object.keys(x).length === 1 ? BigInt(x.$b) : x)) as T;

/** Forget the sample network (a new demo session starts fresh). */
export function resetDemoNetworks() {
  for (const id of [...nets.keys(), 998, 10143]) {
    try {
      globalThis.sessionStorage?.removeItem(STORE(id));
    } catch {}
  }
  nets.clear();
}

export function demoNet(chainId: number): Net | undefined {
  const hit = nets.get(chainId);
  if (hit) return hit;
  const spec = specOf(chainId);
  if (!spec) return undefined;
  spec.base = spec.markets.length;
  const tokens = new Map(spec.tokens.map((t) => [lc(t.address), t]));
  let st: ChainState | undefined;
  try {
    const raw = globalThis.sessionStorage?.getItem(STORE(chainId));
    if (raw) {
      const s = de<ChainState>(raw);
      if (s?.v === 4 && s.chainId === chainId) st = s;
    }
  } catch {}
  let timer: ReturnType<typeof setTimeout> | undefined;
  const net: Net = {
    spec,
    st: st ?? (undefined as unknown as ChainState),
    history: new Map(),
    tokens,
    save: () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        try {
          globalThis.sessionStorage?.setItem(STORE(chainId), ser(net.st));
        } catch {}
      }, 400);
    },
  };
  for (const m of st?.extraMarkets ?? []) spec.markets.push(m);
  if (!st) {
    // a fixed seed per network: every session (and every test run) sees the same sample market
    net.st = create(spec, hashStr(`confluere.demo.${chainId}`), now());
    buildHistory(net);
    seedState(net);
  } else buildHistory(net);
  nets.set(chainId, net);
  net.save();
  return net;
}

// ───────────────────────────── price model ─────────────────────────────

function fairApr(m: MarketSpec, k: number, ref: number) {
  const mny = k / ref;
  if (m.pegged) return 0.03 + 0.6 * Math.max(0, mny - 0.93);
  return (m.kind === Kind.European ? 0.05 : 0.055) + 0.55 * Math.max(0, mny - 0.7) ** 1.1;
}

/**
 * How a pool's price wanders (so charts show a market, not a line converging to the buy-back price):
 * - the rate carries mean-reverting noise (about a day to revert) on top of a fair rate set by how close the buy-back
 *   price is to the reference price;
 * - the price carries a mean-reverting premium (about half a day) and follows the collateral a little (a lender
 *   position is worth less when the collateral falls), plus per-trade noise for wicks;
 * - both shrink as maturity nears (`tauScale`), so a pool about to mature trades close to its fair value.
 * The steady rise of a fixed-rate price toward the buy-back price is then smaller than the swings in any 1D / 1W view.
 */
const RATE_TAU = DAY;
const PREMIUM_TAU = 12 * HOUR;
const rateSd = (m: MarketSpec) => (m.pegged ? 0.009 : 0.024);
const premiumSd = (m: MarketSpec) => (m.pegged ? 0.0008 : 0.0025);
const tradeSd = (m: MarketSpec) => (m.pegged ? 0.0002 : 0.0009);
/** Now and then the rate jumps (news, a large borrower), then reverts with the noise. */
const jump = (m: MarketSpec, r: () => number, p: number) => (r() < p ? (r() < 0.6 ? 1 : -1) * (0.5 + r()) * rateSd(m) * 2 : 0);
/** How much the price follows the collateral: more when the buy-back price is close to the collateral's value. */
const refBeta = (m: MarketSpec, moneyness: number) => (m.pegged ? 0 : 0.03 + 0.3 * Math.max(0, moneyness - 0.7));
const tauScale = (expiry: number, t: number) => Math.min(1, Math.max(expiry - t, 1800) / (14 * DAY));
/** One exact step of an Ornstein-Uhlenbeck process: reverts to 0 with time constant `tau`, stationary deviation `sd`. */
const ou = (x: number, dt: number, tau: number, sd: number, g: number) => {
  const a = Math.exp(-Math.max(0, dt) / tau);
  return x * a + sd * Math.sqrt(1 - a * a) * g;
};
const poisson = (r: () => number, mu: number) => {
  const L = Math.exp(-mu);
  let k = 0;
  for (let p = r(); p > L; p *= r()) k++;
  return k;
};

/** A fill: log-normal around the market's typical size, with the odd whale. */
const tradeSize = (m: MarketSpec, r: () => number) => {
  const [lo, hi] = m.size;
  const u = Math.sqrt(lo * hi) * Math.exp(gauss(r) * 0.9) * (r() < 0.04 ? 3 + r() * 5 : 1);
  return Math.min(hi * 8, Math.max(lo / 4, u));
};

function modelPrice(m: MarketSpec, k: number, expiry: number, ref: number, t: number, noise: number, premium = 0, level?: number): number {
  const tau = Math.max(expiry - t, 1800) / YEAR;
  const fairR = fairApr(m, k, ref);
  const apr = Math.max(0.4 * fairR, fairR + noise);
  const dev = level && level > 0 ? refBeta(m, k / ref) * Math.log(ref / level) : 0;
  // discount to the buy-back price, in log terms; kept above a quarter of the fair rate with a smooth floor (a hard cap
  // would draw flat tops), so the price never reaches the buy-back price
  const gap = Math.log(1 + apr * tau) - tauScale(expiry, t) * (premium + dev);
  const floor = Math.log(1 + 0.25 * fairR * tau);
  const w = Math.max(1e-9, 0.5 * fairR * tau);
  const x = (gap - floor) / w;
  const soft = floor + w * (x > 30 ? x : Math.log1p(Math.exp(x)));
  return Math.min(k / Math.exp(soft), ref * (m.pegged ? 0.995 : 0.985));
}

const quoteDecOf = (net: Net, quote: string) => net.tokens.get(lc(quote))?.decimals ?? 18;

// ───────────────────────────── creation ─────────────────────────────

/** Pairs quoted the other way round follow their base pair exactly (USDC / WHYPE = 1 / WHYPE / USDC). */
function syncInverse(spec: ChainSpec, refs: Record<string, number>) {
  for (const [k, v] of Object.entries(spec.refs)) if (v.inverse && refs[v.inverse]) refs[k] = 1 / refs[v.inverse]!;
  for (const [k, v] of Object.entries(spec.refs)) if (v.product && refs[v.product[0]] && refs[v.product[1]]) refs[k] = refs[v.product[0]]! * refs[v.product[1]]!;
}
const derived = (v: { inverse?: string; product?: [string, string] }) => !!v.inverse || !!v.product;

function create(spec: ChainSpec, seed: number, s0: number): ChainState {
  const r = rng(seed);
  const refs: Record<string, number> = {};
  for (const [k, v] of Object.entries(spec.refs)) if (!derived(v)) refs[k] = v.p * (v.vol > 0.001 ? 0.97 + r() * 0.06 : 1);
  syncInverse(spec, refs);
  return {
    v: 4,
    chainId: spec.id,
    seed,
    s0,
    refs: { ...refs },
    refs0: refs,
    lastDrift: s0,
    round: batchAt(s0),
    pools: {},
    orders: [],
    nextOrderId: 1,
    erc20: {},
    native: {},
    allowance: {},
    b6909: {},
    supply6909: {},
    lockedR: {},
    pending: {},
    operators: {},
    graduated: {},
    marketFees: {},
    feesSplit: {},
    seats: {},
    seatClaimable: {},
    vaults: {},
    wrappers: {},
    wrapped: {},
    expiryWindowEnd: {},
    adopted: [],
    seatGiven: false,
    extraMarkets: [],
  };
}

type PoolPlan = { m: number; tier: number; expiry: number; strike: number; special?: "window" | "closed" };

function poolPlans(spec: ChainSpec, s0: number): PoolPlan[] {
  const first = firstMaturity(s0);
  const out: PoolPlan[] = [];
  spec.markets.forEach((m, mi) => {
    if (mi >= (spec.base ?? spec.markets.length)) return;
    for (const d of m.days) m.strikes.forEach((k, ti) => out.push({ m: mi, tier: ti, expiry: first + (d - 1) * DAY, strike: k }));
    if (m.window !== undefined) out.push({ m: mi, tier: m.window, expiry: s0 - 15 * 60, strike: m.strikes[m.window]!, special: "window" });
    if (m.closed !== undefined) out.push({ m: mi, tier: m.closed, expiry: first - 2 * DAY, strike: m.strikes[m.closed]!, special: "closed" });
  });
  return out;
}

/** Hourly reference path for the 31 days before the session started, oldest first (deterministic per seed). */
function refPath(spec: ChainSpec, st: ChainState, key: string): number[] {
  const v = spec.refs[key]!;
  if (v.inverse) return refPath(spec, st, v.inverse).map((x) => 1 / x);
  if (v.product) {
    const b = refPath(spec, st, v.product[1]);
    return refPath(spec, st, v.product[0]).map((x, i) => x * b[i]!);
  }
  const r = rng(st.seed ^ hashStr(key));
  const n = 31 * 24 + 1;
  const back: number[] = [st.refs0[key] ?? v.p];
  const lst = v.vol < 0.001;
  for (let i = 1; i < n; i++) {
    const prev = back[i - 1]!;
    // walking back in time: mean-revert gently to the spec level so a month never wanders off; a staking rate was
    // a little lower in the past (about 2% a year)
    const pull = lst ? -0.000_0025 : Math.log(v.p / prev) * 0.01;
    back.push(prev * Math.exp(gauss(r) * v.vol + pull));
  }
  return back.reverse();
}

function buildHistory(net: Net) {
  const { spec, st } = net;
  const paths: Record<string, number[]> = {};
  for (const k of Object.keys(spec.refs)) paths[k] = refPath(spec, st, k);
  const start = st.s0 - 31 * DAY;
  const refAt = (key: string, t: number) => {
    const p = paths[key]!;
    const i = Math.max(0, Math.min(p.length - 1, Math.floor((t - start) / HOUR)));
    return p[i]!;
  };
  const plans = poolPlans(spec, st.s0);
  const firstTime = Object.keys(st.pools).length === 0;
  for (const plan of plans) {
    const m = spec.markets[plan.m]!;
    const qd = quoteDecOf(net, m.quote);
    const ad = net.tokens.get(lc(m.asset))?.decimals ?? 18;
    const strike = toUnits(plan.strike, qd);
    const id = poolId({ asset: m.asset, quote: m.quote, expiry: BigInt(plan.expiry), strike, kind: m.kind });
    const r = rng(st.seed ^ hashStr(id));
    const listed = Math.max(st.s0 - 30 * DAY, plan.expiry - 45 * DAY);
    const end = Math.min(st.s0, plan.expiry);
    const tierAct = [0.6, 0.95, 0.7][Math.min(plan.tier, 2)] ?? 0.7;
    const act = Math.max(0.45, m.activity * tierAct * (plan.special ? 0.9 : 1));
    const rows: Row[] = [];
    const level = spec.refs[m.ref]?.p;
    let noise = gauss(r) * rateSd(m);
    let z = gauss(r) * premiumSd(m);
    let lastT = listed;
    // busier in the last week (several trades an hour, so hourly candles have bodies and wicks), quieter before
    const busy = st.s0 - 7 * DAY;
    let regime = 1;
    for (let h = Math.floor(listed / HOUR) * HOUR; h < end; h += HOUR) {
      const hourOfDay = (h / HOUR) % 24;
      if (hourOfDay === 0) regime = Math.exp(gauss(r) * 0.4);
      const diurnal = 0.55 + 0.45 * Math.sin(((hourOfDay - 6) / 24) * Math.PI * 2);
      // busier and quieter days, the odd quiet hour, and a market that has grown over the month
      const growth = 0.4 + 0.6 * Math.min(1, Math.max(0, 1 - (st.s0 - h) / (30 * DAY)));
      const n = r() < 0.06 ? 0 : poisson(r, act * diurnal * regime * growth * (h >= busy ? 9 : 5));
      const times = Array.from({ length: n }, () => h + Math.floor(r() * HOUR))
        .filter((t) => t >= listed && t < end)
        .sort((a, b) => a - b);
      for (const t of times) {
        noise = ou(noise, t - lastT, RATE_TAU, rateSd(m), gauss(r)) + jump(m, r, 0.012);
        z = ou(z, t - lastT, PREMIUM_TAU, premiumSd(m), gauss(r));
        lastT = t;
        const ref = refAt(m.ref, t);
        const px = modelPrice(m, plan.strike, plan.expiry, ref, t, noise, z + gauss(r) * tradeSd(m), level);
        const [lo, hi] = m.size;
        const units = toUnits(tradeSize(m, r), ad);
        rows.push({ index: batchAt(t), price: priceUnits(px, qd), units, nc: mulF(units, 0.3 + r() * 0.4), block: blockAt(spec, t) });
      }
    }
    rows.sort((a, b) => a.index - b.index);
    // one row per round: merge rows that landed in the same round
    const merged: Row[] = [];
    for (const x of rows) {
      const last = merged[merged.length - 1];
      if (last && last.index === x.index) {
        last.units += x.units;
        last.nc += x.nc;
      } else merged.push({ ...x });
    }
    net.history.set(id, merged);
    if (!firstTime) continue;
    // pool state from its history
    const sum = merged.reduce((s, x) => s + x.units, 0n);
    const vwapNum = merged.reduce((s, x) => s + x.price * x.units, 0n);
    const volume = merged.reduce((s, x) => s + quoteDown(x.units, x.price, scaleOf(ad)), 0n);
    const last = merged[merged.length - 1];
    const repaidF = plan.special === "closed" ? 0.8 : plan.special === "window" ? 0.45 : m.kind === Kind.American ? 0.08 + r() * 0.17 : 0;
    const repaid = mulF(sum, repaidF);
    const claimedF = plan.special === "closed" ? 0.4 : 0;
    const keep = (v: B) => mulF(v, 1 - claimedF);
    let status: number = Status.Open;
    let windowEnd = 0n;
    if (plan.special === "window") {
      status = Status.Window;
      windowEnd = BigInt(blockAt(spec, plan.expiry) + demoDeploymentOf(spec.id)!.windowBlocks);
      st.expiryWindowEnd[String(plan.expiry)] = windowEnd;
    } else if (plan.special === "closed") {
      status = Status.Closed;
      windowEnd = BigInt(blockAt(spec, plan.expiry) + demoDeploymentOf(spec.id)!.windowBlocks);
      st.expiryWindowEnd[String(plan.expiry)] = windowEnd;
    }
    const pool: PoolS = {
      id,
      asset: m.asset,
      quote: m.quote,
      expiry: plan.expiry,
      strike,
      kind: m.kind,
      m: plan.m,
      tier: plan.tier,
      assetDecimals: ad,
      feeBps: m.fee,
      bandBps: m.band,
      status,
      settleCount: Math.max(0, Math.floor((end - listed) / iv)),
      windowEnd,
      lastPrice: last?.price ?? 0n,
      vwapNum,
      vwapDen: sum,
      quoteBal: keep(repayAmount(repaid, strike, scaleOf(ad))),
      assetBal: keep(sum - repaid),
      volume,
      noise,
      z,
      minFill: 0n,
      firstLo: 0n,
      firstHi: 0n,
      cadence: 0,
      createdBlock: blockAt(spec, listed),
      generated: true,
      special: plan.special,
      rows: [],
    };
    st.pools[id] = pool;
    st.supply6909[cTokenId(id).toString()] = keep(sum);
    st.supply6909[rTokenId(id).toString()] = plan.special === "closed" ? 0n : sum - repaid;
    const mid = marketId(m.asset, m.quote, m.kind);
    st.graduated[mid] = m.graduated;
    if (repaid > 0n && last) {
      const fee = spreadFee(repaid, strike, vwapNum / (sum || 1n), m.fee, scaleOf(ad));
      st.marketFees[mid] = (st.marketFees[mid] ?? 0n) + fee;
    }
  }
}

function seedState(net: Net) {
  const { spec, st } = net;
  // seats
  spec.markets.forEach((m, mi) => {
    const mid = marketId(m.asset, m.quote, m.kind);
    st.feesSplit[mid] = mulF(st.marketFees[mid] ?? 0n, 0.6);
    if (m.seat === undefined) return;
    const qd = quoteDecOf(net, m.quote);
    const ob = toUnits(spec.obligation[lc(m.quote)] ?? 0, qd);
    const holder = m.seat === "user" ? DEMO_ACCOUNT : SYN[(m.seat * 3 + mi) % SYN.length]!;
    st.seats[mid] = {
      holder,
      price: toUnits(m.seatPrice ?? 1000, qd),
      deposit: toUnits((m.seatPrice ?? 1000) * 0.08, qd),
      bond: ob / 10n,
      lastTax: st.s0 - 3 * DAY,
      priceLockedUntil: st.s0 + 2 * DAY,
      lastQuotedBatch: st.round,
    };
  });
  // vaults
  spec.vaults.forEach((v) => {
    if (!v.address || v.address === zeroAddress) return;
    const m = spec.markets[v.market]!;
    const qd = quoteDecOf(net, v.quote);
    const ta = toUnits(v.tvl, qd);
    const vs: VaultS = {
      address: v.address,
      name: v.name,
      symbol: v.symbol,
      quote: v.quote,
      assets: [m.asset],
      kind: m.kind,
      strikeRule: v.strikeRule,
      epoch: 14 + Math.floor(rng(st.seed ^ hashStr(v.address))() * 20),
      targetExpiry: nextGrid(st.s0 + HOUR),
      ta,
      t0: st.s0,
      apr: v.apr,
      supply: (ta * 10n ** 6n * 1000n) / 1036n,
      pendingDepositAssets: mulF(ta, 0.012),
      pendingRedeemShares: mulF((ta * 10n ** 6n * 1000n) / 1036n, 0.008),
      lastPokeBatch: st.round,
      market: v.market,
      tier: v.tier,
      accts: {},
    };
    st.vaults[lc(v.address)] = vs;
    // the vault's lender units, in the pools it lends into
    for (const p of vaultPools(net, vs)) {
      const units = p.lastPrice > 0n ? (mulF(ta, 0.7 / 3) * scaleOf(p.assetDecimals)) / p.lastPrice : 0n;
      const have = st.supply6909[cTokenId(p.id).toString()] ?? 0n;
      const u = units < have ? units : have / 2n;
      st.b6909[`${cTokenId(p.id)}|${lc(v.address)}`] = u;
    }
  });
  regenerateBooks(net);
  ensureAccount(net, DEMO_ACCOUNT);
}

function vaultPools(net: Net, v: VaultS): PoolS[] {
  const all = Object.values(net.st.pools).filter((p) => p.m === v.market && p.status === Status.Open && !p.special && p.lastPrice > 0n);
  const tierOk = (p: PoolS) => {
    const n = net.spec.markets[p.m]!.strikes.length;
    return v.tier === "any" || (v.tier === "low" ? p.tier === 0 : p.tier === n - 1);
  };
  return all.filter(tierOk).sort((a, b) => a.expiry - b.expiry).slice(0, 3);
}

// ───────────────────────────── accounts ─────────────────────────────

const contractAddrs = (net: Net) => {
  const d = demoDeploymentOf(net.spec.id)!;
  return new Set([d.confluere, d.router, d.seatRegistry, d.vaultFactory, d.wrapperFactory, ...Object.values(d.vaults ?? {}), ...Object.values(d.seatLPTokens ?? {})].filter(Boolean).map((a) => lc(a!)));
};

function isPerson(net: Net, a: string | undefined): a is string {
  if (!a || lc(a) === zeroAddress) return false;
  const x = lc(a);
  if (SYN.some((s) => s === x)) return false;
  if (net.tokens.has(x) || contractAddrs(net).has(x)) return false;
  if (Object.values(net.st.wrappers).some((w) => lc(w) === x)) return false;
  return true;
}

/** Give a wallet seen for the first time its starting balances and positions. */
function ensureAccount(net: Net, account: string | undefined) {
  if (!isPerson(net, account)) return;
  const a = lc(account);
  const { st, spec } = net;
  if (st.adopted.includes(a)) return;
  st.adopted.push(a);
  const u = spec.user;
  st.native[a] = toUnits(u.native, 18);
  for (const [t, x] of u.tokens) st.erc20[`${lc(t)}|${a}`] = toUnits(x, net.tokens.get(lc(t))!.decimals);
  const findPool = (mi: number, at: number | "window" | "closed", s: number) => {
    const m = spec.markets[mi]!;
    const first = firstMaturity(st.s0);
    return Object.values(st.pools).find((p) => {
      if (p.m !== mi || p.tier !== s) return false;
      if (at === "window" || at === "closed") return p.special === at;
      return !p.special && p.expiry === first + (at - 1) * DAY && m.strikes[s] !== undefined;
    });
  };
  const mint = (id: B, units: B, to: string) => {
    st.b6909[`${id}|${to}`] = (st.b6909[`${id}|${to}`] ?? 0n) + units;
    st.supply6909[id.toString()] = (st.supply6909[id.toString()] ?? 0n) + units;
  };
  for (const l of u.loans) {
    const p = findPool(l.m, l.at, l.s);
    if (!p) continue;
    const units = toUnits(l.units, p.assetDecimals);
    mint(rTokenId(p.id), units, a);
    st.supply6909[cTokenId(p.id).toString()] = (st.supply6909[cTokenId(p.id).toString()] ?? 0n) + units;
    p.assetBal += units;
  }
  for (const l of u.lends) {
    const p = findPool(l.m, l.at, l.s);
    if (!p) continue;
    const units = toUnits(l.units, p.assetDecimals);
    mint(cTokenId(p.id), units, a);
    if (p.status === Status.Closed) {
      // a closed pool already holds what its lenders are owed (mostly repaid, some collateral)
      p.quoteBal += mulF(repayAmount(units, p.strike, scaleOf(p.assetDecimals)), 0.8);
      p.assetBal += mulF(units, 0.2);
    } else {
      st.supply6909[rTokenId(p.id).toString()] = (st.supply6909[rTokenId(p.id).toString()] ?? 0n) + units;
      p.assetBal += units;
    }
  }
  {
    const o = u.order;
    const p = findPool(o.m, o.at, o.s);
    if (p && p.lastPrice > 0n) {
      const units = toUnits(o.units, p.assetDecimals);
      const limit = mulF(p.lastPrice, 1 - o.below);
      const ttl = 40;
      st.orders.push({ pool: p.id, id: st.nextOrderId++, owner: a as Address, side: Side.Buy, units, limit, escrow: buyEscrow(units, limit, ttl, scaleOf(p.assetDecimals)), budget: 0n, deadline: p.settleCount + ttl, block: blockAt(spec, now()) - 900 });
    }
  }
  {
    const [t, x] = u.pending;
    st.pending[`${lc(t)}|${a}`] = toUnits(x, net.tokens.get(lc(t))!.decimals);
  }
  for (const vp of u.vaults) {
    const vspec = spec.vaults[vp.v];
    const v = vspec && st.vaults[lc(vspec.address)];
    if (!v) continue;
    const qd = quoteDecOf(net, v.quote);
    const ta = vaultTotalAssets(v, now());
    const sharesFor = (x: number) => (v.supply > 0n ? (toUnits(x, qd) * v.supply) / ta : 0n);
    const acct = vaultAcct(v, a);
    acct.shares += sharesFor(vp.shares);
    v.supply += sharesFor(vp.shares);
    v.ta += toUnits(vp.shares, qd);
    if (vp.collect) {
      acct.claimAssets += toUnits(vp.collect, qd);
      acct.claimableRedeem += sharesFor(vp.collect);
    }
    if (vp.queued) {
      acct.pendingRedeem += sharesFor(vp.queued);
      v.pendingRedeemShares += sharesFor(vp.queued);
    }
  }
  // the first wallet that connects takes over the sample LP seats
  if (a !== lc(DEMO_ACCOUNT) && !st.seatGiven) {
    st.seatGiven = true;
    for (const [mid, s] of Object.entries(st.seats)) {
      if (lc(s.holder) !== lc(DEMO_ACCOUNT)) continue;
      s.holder = a as Address;
      const m = spec.markets.find((x) => marketId(x.asset, x.quote, x.kind) === mid);
      if (m) st.seatClaimable[`${lc(m.quote)}|${a}`] = toUnits((m.seatPrice ?? 1000) * 0.006, quoteDecOf(net, m.quote));
    }
  }
  net.save();
}

function vaultAcct(v: VaultS, a: string): VaultAcct {
  return (v.accts[lc(a)] ??= { pendingDeposit: 0n, claimableDeposit: 0n, pendingRedeem: 0n, claimableRedeem: 0n, shares: 0n, claimShares: 0n, claimAssets: 0n, credits: {} });
}

const vaultTotalAssets = (v: VaultS, t: number) => v.ta + mulF(v.ta, (v.apr * Math.max(0, t - v.t0)) / YEAR);

// ───────────────────────────── order books ─────────────────────────────

function regenerateBooks(net: Net, only?: string) {
  const { st } = net;
  st.orders = st.orders.filter((o) => !o.synthetic || (only !== undefined && o.pool !== only));
  for (const p of Object.values(st.pools)) {
    if (only !== undefined && p.id !== only) continue;
    if (p.status !== Status.Open || now() >= p.expiry || p.lastPrice === 0n) continue;
    const m = net.spec.markets[p.m]!;
    const r = rng((st.seed ^ hashStr(p.id)) + st.round);
    // a deep book on both sides: 6 to 12 offers each, laddered away from the last price, sizes from small to walls
    const size = () => toUnits(tradeSize(m, r) * (r() < 0.08 ? 4 + r() * 6 : 1), p.assetDecimals);
    const sc = scaleOf(p.assetDecimals);
    const nS = 6 + Math.floor(r() * 7);
    const nB = 6 + Math.floor(r() * 7);
    const seat = st.seats[marketId(p.asset, p.quote, p.kind)];
    // steps in price terms, smaller for pegged markets and for pools close to maturity (prices sit close to the buy-back price)
    const stepF = (m.pegged ? 0.0004 : 0.0016) * Math.max(0.15, tauScale(p.expiry, now()));
    // sell limits stay below the buy-back price (nobody borrows at a negative rate)
    const capSell = p.strike - p.strike / 4000n;
    let dS = 0;
    let dB = 0;
    for (let i = 0; i < nS; i++) {
      const units = size();
      dS += stepF * (0.3 + r() * 1.7);
      const lim = mulF(p.lastPrice, 1 + dS);
      st.orders.push({ pool: p.id, id: st.nextOrderId++, owner: SYN[Math.floor(r() * SYN.length)]!, side: Side.Sell, units, limit: lim < capSell ? lim : capSell, escrow: units, budget: 0n, deadline: p.settleCount + 1 + Math.floor(r() * 10), block: 0, synthetic: true });
    }
    for (let i = 0; i < nB; i++) {
      const units = size();
      dB += stepF * (0.3 + r() * 1.7);
      const limit = mulF(p.lastPrice, 1 - dB);
      const isSeat = i === 0 && !!seat && seat.holder !== zeroAddress;
      st.orders.push({ pool: p.id, id: st.nextOrderId++, owner: isSeat ? seat!.holder : SYN[Math.floor(r() * SYN.length)]!, side: Side.Buy, units, limit, escrow: buyEscrow(units, limit, 2, sc), budget: 0n, deadline: p.settleCount + 2, block: 0, synthetic: true, locked: isSeat });
    }
    for (let i = Math.floor(r() * 4); i > 0; i--) {
      const budget = quoteDown(size(), p.lastPrice, sc);
      st.orders.push({ pool: p.id, id: st.nextOrderId++, owner: SYN[Math.floor(r() * SYN.length)]!, side: Side.NcBuy, units: 0n, limit: mulF(p.lastPrice, 0.9995), escrow: budget, budget, deadline: p.settleCount + 4, block: 0, synthetic: true });
    }
    for (let i = Math.floor(r() * 3); i > 0; i--) {
      const units = size();
      st.orders.push({ pool: p.id, id: st.nextOrderId++, owner: SYN[Math.floor(r() * SYN.length)]!, side: Side.NcSell, units, limit: mulF(p.lastPrice, 0.995), escrow: units, budget: 0n, deadline: p.settleCount + 4, block: 0, synthetic: true });
    }
  }
}

/** Orders of one pool and side in book order (best first), as the core's sorted lists. */
function bookSide(st: ChainState, pid: string, side: number): OrderS[] {
  const xs = st.orders.filter((o) => lc(o.pool) === lc(pid) && o.side === side);
  if (side === Side.Sell) return xs.sort((a, b) => (a.limit < b.limit ? -1 : a.limit > b.limit ? 1 : a.id - b.id));
  if (side === Side.Buy || side === Side.Bid) return xs.sort((a, b) => (a.limit > b.limit ? -1 : a.limit < b.limit ? 1 : a.id - b.id));
  return xs.sort((a, b) => a.id - b.id);
}

// ───────────────────────────── time passes ─────────────────────────────

/** Bring the sample network up to the wall clock: reference drift, maturities, windows, vault rolls and rounds. */
export function advance(net: Net, t = now()): boolean {
  const { st, spec } = net;
  let changed = false;
  // reference prices: a small step every 5 s
  const steps = Math.min(720, Math.floor((t - st.lastDrift) / 5));
  if (steps > 0) {
    for (const [k, v] of Object.entries(spec.refs)) {
      if (derived(v)) continue;
      let x = st.refs[k] ?? v.p;
      const r = rng((st.seed ^ hashStr(k)) + Math.floor(st.lastDrift / 5));
      for (let i = 0; i < steps; i++) {
        const pull = Math.log(v.p / x) * 0.0002;
        x *= Math.exp(gauss(r) * v.vol * 0.04 + pull + (r() < 0.0005 ? gauss(r) * v.vol * 3 : 0));
      }
      st.refs[k] = x;
    }
    syncInverse(spec, st.refs);
    st.lastDrift += steps * 5;
    changed = true;
  }
  const target = batchAt(t);
  if (target - st.round > 360) st.round = target - 360;
  let rounds = 0;
  while (st.round < target) {
    st.round++;
    runRound(net, DEMO_GRID.anchor + st.round * iv);
    rounds++;
  }
  if (rounds > 0) {
    regenerateBooks(net);
    net.save();
    emit(spec.id, "round");
  } else if (changed) net.save();
  return rounds > 0;
}

function runRound(net: Net, T: number) {
  const { st, spec } = net;
  const wb = demoDeploymentOf(spec.id)!.windowBlocks;
  const blockT = blockAt(spec, T);
  for (const p of Object.values(st.pools)) {
    if (p.status === Status.Open && T >= p.expiry) {
      const key = String(p.expiry);
      st.expiryWindowEnd[key] ??= BigInt(blockAt(spec, Math.max(p.expiry, T)) + wb);
      p.status = Status.Window;
      p.windowEnd = st.expiryWindowEnd[key]!;
      dropOrders(net, p, (o) => o.side !== Side.Bid);
    } else if (p.status === Status.Window && BigInt(blockT) >= p.windowEnd) {
      p.status = Status.Closed;
      st.supply6909[rTokenId(p.id).toString()] = 0n;
      dropOrders(net, p, () => true);
    } else if (p.status === Status.Open && T < p.expiry) settlePool(net, p, T);
  }
  for (const v of Object.values(st.vaults)) {
    if (T < v.targetExpiry) continue;
    rollVault(net, v, T);
  }
  for (const s of Object.values(st.seats)) if (s.holder !== zeroAddress) s.lastQuotedBatch = st.round;
}

function rollVault(net: Net, v: VaultS, T: number) {
  const ta = vaultTotalAssets(v, T);
  for (const acct of Object.values(v.accts)) {
    if (acct.pendingDeposit > 0n) {
      const sh = v.supply > 0n ? (acct.pendingDeposit * v.supply) / ta : acct.pendingDeposit * 10n ** 6n;
      acct.claimShares += sh;
      acct.claimableDeposit += acct.pendingDeposit;
      acct.pendingDeposit = 0n;
    }
    if (acct.pendingRedeem > 0n) {
      acct.claimAssets += v.supply > 0n ? (acct.pendingRedeem * ta) / v.supply : 0n;
      acct.claimableRedeem += acct.pendingRedeem;
      acct.pendingRedeem = 0n;
    }
  }
  v.pendingDepositAssets = 0n;
  v.pendingRedeemShares = 0n;
  v.epoch++;
  v.targetExpiry = nextGrid(T + 1);
  v.lastPokeBatch = net.st.round;
}

function dropOrders(net: Net, p: PoolS, which: (o: OrderS) => boolean) {
  const { st } = net;
  const keep: OrderS[] = [];
  for (const o of st.orders) {
    if (lc(o.pool) === lc(p.id) && which(o)) refund(net, p, o);
    else keep.push(o);
  }
  st.orders = keep;
}

function refund(net: Net, p: PoolS, o: OrderS) {
  if (o.synthetic) return;
  const { st } = net;
  const isSell = o.side === Side.Sell || o.side === Side.NcSell;
  const token = isSell && !o.rollFrom ? p.asset : p.quote;
  credit(st.pending, `${lc(token)}|${lc(o.owner)}`, o.escrow);
  if (o.rollFrom) st.lockedR[`${lc(o.owner)}|${lc(o.rollFrom)}`] = sub0(st.lockedR[`${lc(o.owner)}|${lc(o.rollFrom)}`] ?? 0n, o.units);
}

const credit = (m: Record<string, B>, k: string, v: B) => {
  m[k] = (m[k] ?? 0n) + v;
};
const sub0 = (a: B, b: B) => (a > b ? a - b : 0n);

function settlePool(net: Net, p: PoolS, T: number) {
  const { st, spec } = net;
  const m = spec.markets[p.m]!;
  p.settleCount++;
  const ref = st.refs[m.ref];
  const qd = quoteDecOf(net, p.quote);
  const k = fromUnits(p.strike, qd);
  const r = rng(((st.seed ^ hashStr(p.id)) + st.round * 7919) >>> 0);
  p.noise = ou(p.noise, iv, RATE_TAU, rateSd(m), gauss(r)) + jump(m, r, 0.0008);
  p.z = ou(p.z ?? 0, iv, PREMIUM_TAU, premiumSd(m), gauss(r));
  const model = ref ? priceUnits(modelPrice(m, k, p.expiry, ref, T, p.noise, p.z + gauss(r) * tradeSd(m), spec.refs[m.ref]?.p), qd) : 0n;
  const mine = st.orders.filter((o) => lc(o.pool) === lc(p.id) && !o.synthetic && o.side !== Side.Bid);
  // a pool with no model price fills crossing orders at the best limit on the sell side
  const P = model > 0n ? model : (mine.filter((o) => o.side === Side.Sell).map((o) => o.limit).sort((a, b) => (a < b ? -1 : 1))[0] ?? 0n);
  const sc = scaleOf(p.assetDecimals);
  let filled = 0n;
  let nc = 0n;
  let sold = 0n;
  let bought = 0n;
  if (P > 0n) {
    const keep: OrderS[] = [];
    for (const o of st.orders) {
      if (!mine.includes(o)) {
        keep.push(o);
        continue;
      }
      const sell = o.side === Side.Sell || o.side === Side.NcSell;
      const ok = sell ? o.limit <= P : o.limit >= P;
      if (!ok) {
        if (o.deadline <= p.settleCount) refund(net, p, o);
        else keep.push(o);
        continue;
      }
      const owner = lc(o.owner);
      if (sell) {
        const u = o.units;
        const proceeds = quoteDown(u, P, sc);
        if (o.rollFrom) {
          const old = st.pools[o.rollFrom];
          const oldPay = old ? repayAmount(u, old.strike, scaleOf(old.assetDecimals)) : 0n;
          const rOld = rTokenId(o.rollFrom);
          st.b6909[`${rOld}|${owner}`] = sub0(st.b6909[`${rOld}|${owner}`] ?? 0n, u);
          st.supply6909[rOld.toString()] = sub0(st.supply6909[rOld.toString()] ?? 0n, u);
          st.lockedR[`${owner}|${lc(o.rollFrom)}`] = sub0(st.lockedR[`${owner}|${lc(o.rollFrom)}`] ?? 0n, u);
          if (old) {
            old.quoteBal += oldPay;
            old.assetBal = sub0(old.assetBal, u);
          }
          credit(st.pending, `${lc(p.quote)}|${owner}`, sub0(proceeds + o.escrow, oldPay));
        } else credit(st.pending, `${lc(p.quote)}|${owner}`, proceeds);
        credit(st.b6909, `${rTokenId(p.id)}|${owner}`, u);
        credit(st.supply6909, rTokenId(p.id).toString(), u);
        credit(st.supply6909, cTokenId(p.id).toString(), u);
        p.assetBal += u;
        filled += u;
        sold += u;
        if (o.side === Side.NcSell) nc += u;
      } else {
        const u = o.side === Side.NcBuy ? (o.budget * sc) / P : o.units;
        const cost = quoteUp(u, P, sc);
        credit(st.pending, `${lc(p.quote)}|${owner}`, sub0(o.escrow, cost));
        credit(st.b6909, `${cTokenId(p.id)}|${owner}`, u);
        credit(st.supply6909, cTokenId(p.id).toString(), u);
        credit(st.supply6909, rTokenId(p.id).toString(), u);
        p.assetBal += u;
        filled += u;
        bought += u;
        if (o.side === Side.NcBuy) nc += u;
      }
    }
    st.orders = keep;
  } else {
    for (const o of mine) if (o.deadline <= p.settleCount) refund(net, p, o);
    st.orders = st.orders.filter((o) => !mine.includes(o) || o.deadline > p.settleCount);
  }
  // sample traders
  const pTrade = 0.4 * Math.max(0.5, m.activity) * (p.lastPrice === 0n ? 0.4 : 1) * (net.st.graduated[marketId(p.asset, p.quote, p.kind)] ? 1 : 0.6);
  for (let n = r() < pTrade ? 1 + poisson(r, 0.4) : 0; n > 0 && P > 0n && model > 0n; n--) {
    const u = toUnits(tradeSize(m, r), p.assetDecimals);
    credit(st.supply6909, cTokenId(p.id).toString(), u);
    credit(st.supply6909, rTokenId(p.id).toString(), u);
    p.assetBal += u;
    filled += u;
    nc += mulF(u, 0.4);
  }
  if (filled === 0n) return;
  const [lo, hi] = m.size;
  const typical = toUnits(Math.sqrt(lo * hi), p.assetDecimals) || 1n;
  // your own trades move the price a little: selling lowers it, buying raises it
  const impact = (x: B) => Math.min(0.012, (Number((x * 1000n) / typical) / 1000) * (m.pegged ? 0.0006 : 0.0025));
  p.noise += impact(sold) - impact(bought);
  p.lastPrice = P;
  p.vwapNum += P * filled;
  p.vwapDen += filled;
  p.volume += quoteDown(filled, P, sc);
  p.rows.push({ index: st.round, price: P, units: filled, nc, block: blockAt(spec, T) });
  if (p.rows.length > 900) p.rows = [...p.rows.slice(0, 450).filter((_, i) => i % 3 === 0), ...p.rows.slice(450)];
}

// ───────────────────────────── errors ─────────────────────────────

const ERRORS = [
  ...confluereAbi,
  ...seatRegistryAbi,
  ...vaultAbi,
  ...erc6909WrapperAbi,
  ...parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)", "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)"]),
].filter((x) => x.type === "error") as Abi;

/** A contract revert, shaped like viem's so the app's error copy (lib/txErrors) applies unchanged. */
export function revert(errorName: string, functionName: string, args?: readonly unknown[]): never {
  const data = encodeErrorResult({ abi: ERRORS, errorName, args } as never);
  throw new ContractFunctionRevertedError({ abi: ERRORS, data, functionName });
}

// ───────────────────────────── reads ─────────────────────────────

export type Call = { address: Address; functionName: string; args?: readonly unknown[] };

const seatTax = (s: SeatS, taxBps: number, t: number): B => {
  if (s.holder === zeroAddress) return 0n;
  const owed = (s.price * BigInt(taxBps) * BigInt(Math.max(0, t - s.lastTax))) / (10_000n * BigInt(YEAR));
  return owed > s.deposit ? s.deposit : owed;
};
const TAX_BPS = 1500;
const SHARE_BPS = 3500;

const seatKey = (asset: string, quote: string, kind: number) => marketId(asset as Hex, quote as Hex, kind);
const marketOfLp = (net: Net, lp: string) => {
  const d = demoDeploymentOf(net.spec.id)!;
  const hit = Object.entries(d.seatLPTokens ?? {}).find(([, a]) => lc(a) === lc(lp));
  if (!hit) return undefined;
  const [asset, quote, kind] = hit[0].split("-");
  return { asset: asset as Address, quote: quote as Address, kind: Number(kind) };
};

function poolView(net: Net, p: PoolS) {
  return {
    key: { asset: p.asset, quote: p.quote, expiry: BigInt(p.expiry), strike: p.strike, kind: p.kind },
    status: p.status,
    assetDecimals: p.assetDecimals,
    feeBps: p.feeBps,
    bandBps: p.bandBps,
    bandFailures: 0,
    settleCount: p.settleCount,
    lastSettledBatch: BigInt(net.st.round),
    windowEnd: p.windowEnd,
    pausedUntil: 0n,
    lastClearingPrice: p.lastPrice,
    bandBase: p.lastPrice,
    quoteBal: p.quoteBal,
    assetBal: p.assetBal,
    surplusBal: 0n,
    vwap: p.vwapDen > 0n ? p.vwapNum / p.vwapDen : 0n,
    closeRemaining: 0n,
    options: { cadence: p.cadence, minFill: p.minFill, firstLo: p.firstLo, firstHi: p.firstHi },
    batchInterval: BigInt(iv),
  };
}

const EMPTY_POOL = {
  key: { asset: zeroAddress, quote: zeroAddress, expiry: 0n, strike: 0n, kind: 0 },
  status: 0,
  assetDecimals: 0,
  feeBps: 0,
  bandBps: 0,
  bandFailures: 0,
  settleCount: 0,
  lastSettledBatch: 0n,
  windowEnd: 0n,
  pausedUntil: 0n,
  lastClearingPrice: 0n,
  bandBase: 0n,
  quoteBal: 0n,
  assetBal: 0n,
  surplusBal: 0n,
  vwap: 0n,
  closeRemaining: 0n,
  options: { cadence: 0, minFill: 0n, firstLo: 0n, firstHi: 0n },
  batchInterval: 0n,
};

const lstRate = (net: Net, t: TokenSpec) => {
  const key = Object.keys(net.spec.refs).find((k) => k.startsWith(`${t.symbol}/`));
  return key ? net.st.refs[key]! : t.lst?.rate ?? 1;
};

export function readCall(chainId: number, c: Call): unknown {
  const net = demoNet(chainId);
  if (!net) throw new Error(`demo: no sample network ${chainId}`);
  advance(net);
  const { st, spec } = net;
  const d = demoDeploymentOf(chainId)!;
  const a = lc(c.address);
  const args = (c.args ?? []) as any[];
  const fn = c.functionName;
  const t = now();
  // core
  if (a === lc(d.confluere)) {
    switch (fn) {
      case "pool": {
        const p = st.pools[args[0]];
        return p ? poolView(net, p) : EMPTY_POOL;
      }
      case "nextBatchAt":
        return BigInt(DEMO_GRID.anchor + (st.round + 1) * iv);
      case "graduated":
        return !!st.graduated[args[0]];
      case "expiryWindowEnd":
        return st.expiryWindowEnd[String(Number(args[0]))] ?? 0n;
      case "bookHead": {
        const xs = bookSide(st, args[0], Number(args[1]));
        return [BigInt(xs[0]?.id ?? 0), xs.length];
      }
      case "order": {
        const pid = args[0] as string;
        const id = Number(args[1]);
        const o = st.orders.find((x) => x.id === id && lc(x.pool) === lc(pid));
        if (!o) return [zeroAddress, 0, 0n, 0n, 0n, 0, 0n];
        const xs = bookSide(st, pid, o.side);
        const nx = xs[xs.indexOf(o) + 1];
        return [o.owner, o.side, o.units, o.limit, o.escrow, o.deadline, BigInt(nx?.id ?? 0)];
      }
      case "rolloverSource": {
        const o = st.orders.find((x) => x.id === Number(args[1]) && lc(x.pool) === lc(args[0]));
        return (o?.rollFrom ?? `0x${"0".repeat(64)}`) as Hex;
      }
      case "totalSupply":
        return st.supply6909[BigInt(args[0]).toString()] ?? 0n;
      case "balanceOf":
        ensureAccount(net, args[0]);
        return st.b6909[`${BigInt(args[1])}|${lc(args[0])}`] ?? 0n;
      case "lockedR":
        return st.lockedR[`${lc(args[0])}|${lc(args[1])}`] ?? 0n;
      case "pending":
        ensureAccount(net, args[1]);
        return st.pending[`${lc(args[0])}|${lc(args[1])}`] ?? 0n;
      case "isOperator":
        return !!st.operators[`${lc(args[0])}|${lc(args[1])}`];
      case "marketFees":
        return st.marketFees[args[0]] ?? 0n;
      case "findHint":
        return 0n;
      case "marketStats": {
        const ps = Object.values(st.pools).filter((p) => marketId(p.asset, p.quote, p.kind) === args[0] && p.expiry === Number(args[1]));
        const strikes = ps.map((p) => p.strike).sort((x, y) => (x < y ? -1 : 1));
        return { volume: ps.reduce((s, p) => s + p.volume, 0n), minStrike: strikes[0] ?? 0n, maxStrike: strikes[strikes.length - 1] ?? 0n, bad: false };
      }
      case "graduationVolume": {
        return toUnits(spec.graduationVolume[lc(args[0])] ?? 0, quoteDecOf(net, args[0]));
      }
      case "grid":
        return { anchor: BigInt(DEMO_GRID.anchor), period: BigInt(DEMO_GRID.period), batchInterval: BigInt(iv), maxExpiries: DEMO_GRID.maxExpiries, strikeSigDigits: DEMO_GRID.strikeSigDigits };
      case "minNotional": {
        const q = net.tokens.get(lc(args[0]));
        return toUnits(spec.minNotional[lc(args[0])] ?? 0, q?.decimals ?? 18);
      }
      case "maxFlashLoan": {
        const tk = lc(args[0]);
        let sum = 0n;
        for (const p of Object.values(st.pools)) {
          if (lc(p.asset) === tk) sum += p.assetBal;
          if (lc(p.quote) === tk) sum += p.quoteBal;
        }
        for (const [k, v] of Object.entries(st.pending)) if (k.startsWith(`${tk}|`)) sum += v;
        return sum;
      }
      case "flashFee":
        return (BigInt(args[1]) * 5n) / 10_000n;
    }
  }
  if (d.seatRegistry && a === lc(d.seatRegistry)) {
    switch (fn) {
      case "seatOf": {
        const s = st.seats[seatKey(args[0], args[1], Number(args[2]))];
        if (!s || s.holder === zeroAddress) return [{ holder: zeroAddress, price: 0n, deposit: 0n, bond: 0n, lastTax: 0n, priceLockedUntil: 0n, lastQuotedBatch: 0n }, 0n];
        return [{ holder: s.holder, price: s.price, deposit: s.deposit, bond: s.bond, lastTax: BigInt(s.lastTax), priceLockedUntil: BigInt(s.priceLockedUntil), lastQuotedBatch: BigInt(s.lastQuotedBatch) }, seatTax(s, TAX_BPS, t)];
      }
      case "obligation":
        return toUnits(spec.obligation[lc(args[0])] ?? 0, quoteDecOf(net, args[0]));
      case "claimable":
        return st.seatClaimable[`${lc(args[0])}|${lc(args[1])}`] ?? 0n;
      case "feesSplit":
        return st.feesSplit[args[0]] ?? 0n;
      case "seatShareBps":
        return SHARE_BPS;
      case "taxBps":
        return TAX_BPS;
    }
  }
  if (a === lc(d.vaultFactory)) {
    const list = Object.values(st.vaults);
    if (fn === "vaultsLength") return BigInt(list.length);
    if (fn === "vaults") return list[Number(args[0])]!.address;
  }
  if (a === lc(d.wrapperFactory) && fn === "wrapperOf") return st.wrappers[BigInt(args[0]).toString()] ?? zeroAddress;
  const v = st.vaults[a];
  if (v) {
    const acct = (x: string) => {
      ensureAccount(net, x);
      return vaultAcct(v, x);
    };
    switch (fn) {
      case "name":
        return v.name;
      case "symbol":
        return v.symbol;
      case "decimals":
        return quoteDecOf(net, v.quote) + 6;
      case "asset":
        return v.quote;
      case "epoch":
        return BigInt(v.epoch);
      case "targetExpiry":
        return BigInt(v.targetExpiry);
      case "totalAssets":
        return vaultTotalAssets(v, t);
      case "totalSupply":
        return v.supply;
      case "kind":
        return v.kind;
      case "strikeRule":
        return v.strikeRule;
      case "perBatchCapBps":
        return 2500;
      case "maxPriceBps":
        return 9900;
      case "assets":
        return v.assets;
      case "lastPokeBatch":
        return BigInt(v.lastPokeBatch);
      case "pendingDepositAssets":
        return v.pendingDepositAssets;
      case "pendingRedeemShares":
        return v.pendingRedeemShares;
      case "pendingDepositRequest":
        return acct(args[1]).pendingDeposit;
      case "claimableDepositRequest":
        return acct(args[1]).claimableDeposit;
      case "pendingRedeemRequest":
        return acct(args[1]).pendingRedeem;
      case "claimableRedeemRequest":
        return acct(args[1]).claimableRedeem;
      case "balanceOf":
        return acct(args[0]).shares;
      case "maxMint":
        return acct(args[0]).claimShares;
      case "maxWithdraw":
        return acct(args[0]).claimAssets;
      case "pendingAssetCredit":
        return acct(args[0]).credits[lc(args[1])] ?? 0n;
      case "positions":
        return vaultPools(net, v).map((p, i) => ({ poolId: p.id, lastOrder: BigInt(1000 + i) }));
      case "allowance":
        return 0n;
    }
  }
  const lp = marketOfLp(net, a);
  if (lp) {
    const s = st.seats[seatKey(lp.asset, lp.quote, lp.kind)];
    const qd = quoteDecOf(net, lp.quote);
    const bal = s && s.holder !== zeroAddress ? s.deposit - seatTax(s, TAX_BPS, t) + s.bond : 0n;
    switch (fn) {
      case "balanceOf":
        return s && lc(s.holder) === lc(args[0]) ? bal : 0n;
      case "totalSupply":
        return bal;
      case "decimals":
        return qd;
      case "symbol":
        return `cLP-${net.tokens.get(lc(lp.asset))?.symbol ?? "?"}-${net.tokens.get(lc(lp.quote))?.symbol ?? "?"}`;
      case "name":
        return "Confluere LP";
    }
  }
  const wrapId = Object.entries(st.wrappers).find(([, w]) => lc(w) === a)?.[0];
  if (wrapId) {
    const p = Object.values(st.pools).find((x) => cTokenId(x.id).toString() === wrapId || rTokenId(x.id).toString() === wrapId);
    switch (fn) {
      case "balanceOf":
        return st.wrapped[`${wrapId}|${lc(args[0])}`] ?? 0n;
      case "decimals":
        return p?.assetDecimals ?? 18;
      case "symbol":
        return p && BigInt(wrapId) % 2n === 1n ? "cR" : "cC";
      case "totalSupply":
        return Object.entries(st.wrapped).filter(([k]) => k.startsWith(`${wrapId}|`)).reduce((s, [, x]) => s + x, 0n);
    }
  }
  const tk = net.tokens.get(a);
  if (tk) {
    switch (fn) {
      case "symbol":
        return tk.symbol;
      case "decimals":
        return tk.decimals;
      case "name":
        return tk.symbol;
      case "balanceOf":
        ensureAccount(net, args[0]);
        return st.erc20[`${a}|${lc(args[0])}`] ?? 0n;
      case "allowance":
        return st.allowance[`${a}|${lc(args[0])}|${lc(args[1])}`] ?? 0n;
      case "totalSupply":
        return 10n ** BigInt(tk.decimals + 9);
      case "convertToAssets":
        if (tk.lst) return mulF(BigInt(args[0]), lstRate(net, tk));
        break;
      case "convertToShares":
        if (tk.lst) return mulF(BigInt(args[0]), 1 / lstRate(net, tk));
        break;
    }
  }
  throw new Error(`demo: execution reverted (${fn} on ${c.address})`);
}

// ───────────────────────────── network-level reads ─────────────────────────────

export function headBlock(chainId: number): { number: B; timestamp: B } {
  const net = demoNet(chainId)!;
  const t = now();
  return { number: BigInt(blockAt(net.spec, t)), timestamp: BigInt(t) };
}

export function blockInfo(chainId: number, n: B): { number: B; timestamp: B } {
  const net = demoNet(chainId)!;
  return { number: n, timestamp: BigInt(Math.floor(timeAt(net.spec, Number(n)))) };
}

export function nativeBalance(chainId: number, account: string): B {
  const net = demoNet(chainId);
  if (!net) return 0n;
  ensureAccount(net, account);
  return net.st.native[lc(account)] ?? 0n;
}

/** HyperCore spot price (display only), raw like the precompile: price × 10^(8 − szDecimals). */
export function spotPxRaw(chainId: number, spotIndex: number): B {
  const net = demoNet(chainId);
  if (!net || spotIndex !== 1035) return 0n;
  advance(net);
  const p = net.st.refs["WHYPE/USDC"] ?? 0;
  return BigInt(Math.round(p * 1e6));
}

/** Kuru-style mid for a "MON_USDC" symbol (Monad's reference, display only). */
export function kuruMid(symbol: string): number | null {
  const net = demoNet(10143);
  if (!net || symbol !== "MON_USDC") return null;
  advance(net);
  return net.st.refs["WMON/USDC"] ?? null;
}

// ───────────────────────────── the index the /api routes would serve ─────────────────────────────

const statusOf = (net: Net) => {
  const h = blockAt(net.spec, now());
  return { chainId: net.spec.id, complete: true, scannedTo: h, head: h, updatedAt: Date.now() };
};

const allRows = (net: Net, p: PoolS): Row[] => [...(net.history.get(p.id) ?? []), ...p.rows];

export function indexPools(chainId: number) {
  const net = demoNet(chainId)!;
  advance(net);
  const pools = Object.values(net.st.pools);
  const last: Record<string, { index: number; price: string; units: string; nc: string; block: number }> = {};
  for (const p of pools) {
    const rows = allRows(net, p);
    const r = rows[rows.length - 1];
    if (r) last[p.id] = { index: r.index, price: r.price.toString(), units: r.units.toString(), nc: r.nc.toString(), block: r.block };
  }
  return {
    status: statusOf(net),
    pools: pools.map((p) => ({ id: p.id, block: p.createdBlock, asset: p.asset, quote: p.quote, expiry: p.expiry, strike: p.strike.toString(), kind: p.kind, feeBps: p.feeBps, bandBps: p.bandBps, marketId: marketId(p.asset, p.quote, p.kind) })),
    last,
  };
}

export function indexBatches(chainId: number, pid: string) {
  const net = demoNet(chainId)!;
  advance(net);
  const p = net.st.pools[pid] ?? Object.values(net.st.pools).find((x) => lc(x.id) === lc(pid));
  const rows = p ? allRows(net, p) : [];
  return { status: statusOf(net), rows: [...rows].reverse().map((r) => ({ index: r.index, price: r.price.toString(), units: r.units.toString(), nc: r.nc.toString(), block: r.block })) };
}

export function indexOrders(chainId: number, owner: string) {
  const net = demoNet(chainId)!;
  advance(net);
  ensureAccount(net, owner);
  const orders = net.st.orders.filter((o) => !o.synthetic && lc(o.owner) === lc(owner)).map((o) => ({ pool: o.pool, id: String(o.id), block: o.block }));
  return { status: statusOf(net), orders };
}

export function indexSeatQuotes(chainId: number) {
  const net = demoNet(chainId)!;
  advance(net);
  return { status: statusOf(net), keys: net.st.orders.filter((o) => o.locked).map((o) => `${lc(o.pool)}:${o.id}`) };
}

// ───────────────────────────── writes ─────────────────────────────

export type WriteCall = Call & { value?: bigint };

function pull(net: Net, token: string, owner: string, spender: string, amount: B, fn: string) {
  const { st } = net;
  const k = `${lc(token)}|${lc(owner)}`;
  const bal = st.erc20[k] ?? 0n;
  if (bal < amount) revert("ERC20InsufficientBalance", fn, [owner as Address, bal, amount]);
  const ak = `${lc(token)}|${lc(owner)}|${lc(spender)}`;
  const al = st.allowance[ak] ?? 0n;
  if (al < amount) revert("ERC20InsufficientAllowance", fn, [spender as Address, al, amount]);
  st.erc20[k] = bal - amount;
  if (al < 2n ** 255n) st.allowance[ak] = al - amount;
}

const give = (net: Net, token: string, to: string, amount: B) => credit(net.st.erc20, `${lc(token)}|${lc(to)}`, amount);

function burn6909(net: Net, id: B, from: string, units: B, fn: string) {
  const k = `${id}|${lc(from)}`;
  const have = net.st.b6909[k] ?? 0n;
  if (have < units) revert("InvalidParams", fn);
  net.st.b6909[k] = have - units;
  net.st.supply6909[id.toString()] = sub0(net.st.supply6909[id.toString()] ?? 0n, units);
}

const poolOrRevert = (net: Net, pid: string, fn: string): PoolS => net.st.pools[pid] ?? Object.values(net.st.pools).find((p) => lc(p.id) === lc(pid)) ?? revert("InvalidState", fn);

function canRepayNow(net: Net, p: PoolS, t: number) {
  const block = BigInt(blockAt(net.spec, t));
  if (p.status === Status.Window) return block < p.windowEnd;
  if (p.status !== Status.Open) return false;
  if (t < p.expiry) return p.kind === Kind.American;
  const w = net.st.expiryWindowEnd[String(p.expiry)];
  return w === undefined || block < w;
}

/** Apply one write from `account` (simulate = dry run that changes nothing). Throws a revert like the contract would. */
export function applyWrite(chainId: number, account: Address, w: WriteCall, o: { simulate?: boolean } = {}): void {
  const net = demoNet(chainId);
  if (!net) throw new Error(`demo: no sample network ${chainId}`);
  advance(net);
  ensureAccount(net, account);
  const snapshot = o.simulate ? structuredClone(net.st) : undefined;
  try {
    run(net, lc(account) as Address, w);
  } finally {
    if (snapshot) net.st = snapshot;
  }
  if (!o.simulate) {
    net.save();
    emit(chainId, "write");
  }
}

function run(net: Net, me: Address, w: WriteCall) {
  const { st, spec } = net;
  const d = demoDeploymentOf(spec.id)!;
  const a = lc(w.address);
  const args = (w.args ?? []) as any[];
  const fn = w.functionName;
  const t = now();
  const core = lc(d.confluere);
  if (a === core) {
    switch (fn) {
      case "placeOrder": {
        const p = poolOrRevert(net, args[0], fn);
        if (p.status !== Status.Open || t >= p.expiry) revert("InvalidState", fn);
        const q = args[1] as { side: number; units: B; limit: B; budget: B; ttl: number; owner: Address };
        const owner = q.owner && lc(q.owner) !== zeroAddress ? (lc(q.owner) as Address) : me;
        const sc = scaleOf(p.assetDecimals);
        const ttl = Number(q.ttl) || 1;
        let escrow = 0n;
        if (q.side === Side.Sell || q.side === Side.NcSell) {
          if (q.units <= 0n) revert("InvalidParams", fn);
          escrow = q.units;
          pull(net, p.asset, me, core, escrow, fn);
        } else if (q.side === Side.Buy) {
          if (q.units <= 0n || q.limit <= 0n) revert("InvalidParams", fn);
          escrow = buyEscrow(q.units, q.limit, ttl, sc);
          pull(net, p.quote, me, core, escrow, fn);
        } else if (q.side === Side.NcBuy) {
          if (q.budget <= 0n) revert("InvalidParams", fn);
          escrow = q.budget;
          pull(net, p.quote, me, core, escrow, fn);
        } else revert("InvalidParams", fn);
        st.orders.push({ pool: p.id, id: st.nextOrderId++, owner, side: q.side, units: q.units, limit: q.limit, escrow, budget: q.budget, deadline: p.settleCount + ttl, block: blockAt(spec, t) });
        return;
      }
      case "cancelOrder": {
        const p = poolOrRevert(net, args[0], fn);
        const i = st.orders.findIndex((x) => x.id === Number(args[1]) && lc(x.pool) === lc(p.id));
        const ord = st.orders[i];
        if (!ord) revert("InvalidState", fn);
        if (lc(ord.owner) !== me) revert("NotOwner", fn);
        if (ord.locked) revert("Locked", fn);
        refund(net, p, ord);
        st.orders.splice(i, 1);
        return;
      }
      case "repay": {
        const p = poolOrRevert(net, args[0], fn);
        if (!canRepayNow(net, p, t)) revert("InvalidState", fn);
        const units = BigInt(args[1]);
        const sc = scaleOf(p.assetDecimals);
        const free = (st.b6909[`${rTokenId(p.id)}|${me}`] ?? 0n) - (st.lockedR[`${me}|${lc(p.id)}`] ?? 0n);
        if (units <= 0n || units > free) revert(free < units && (st.lockedR[`${me}|${lc(p.id)}`] ?? 0n) > 0n ? "Locked" : "InvalidParams", fn);
        const pay = repayAmount(units, p.strike, sc);
        pull(net, p.quote, me, core, pay, fn);
        burn6909(net, rTokenId(p.id), me, units, fn);
        const vwap = p.vwapDen > 0n ? p.vwapNum / p.vwapDen : 0n;
        const fee = spreadFee(units, p.strike, vwap, p.feeBps, sc);
        p.quoteBal += pay - fee;
        p.assetBal = sub0(p.assetBal, units);
        const mid = marketId(p.asset, p.quote, p.kind);
        st.marketFees[mid] = (st.marketFees[mid] ?? 0n) + fee;
        give(net, p.asset, me, units);
        return;
      }
      case "claim": {
        const p = poolOrRevert(net, args[0], fn);
        claimPool(net, p, me, fn);
        return;
      }
      case "withdraw": {
        const k = `${lc(args[0])}|${me}`;
        const amt = st.pending[k] ?? 0n;
        st.pending[k] = 0n;
        give(net, args[0], args[1] ?? me, amt);
        return;
      }
      case "rollover": {
        const from = poolOrRevert(net, args[0], fn);
        const to = poolOrRevert(net, args[1], fn);
        const units = BigInt(args[2]);
        if (!canRepayNow(net, from, t) && !(from.status === Status.Open)) revert("InvalidState", fn);
        if (to.status !== Status.Open || t >= to.expiry) revert("InvalidState", fn);
        const free = (st.b6909[`${rTokenId(from.id)}|${me}`] ?? 0n) - (st.lockedR[`${me}|${lc(from.id)}`] ?? 0n);
        if (units <= 0n || units > free) revert("InvalidParams", fn);
        const maxTopUp = BigInt(args[4]);
        if (maxTopUp > 0n) pull(net, from.quote, me, core, maxTopUp, fn);
        credit(st.lockedR, `${me}|${lc(from.id)}`, units);
        st.orders.push({ pool: to.id, id: st.nextOrderId++, owner: me, side: Side.Sell, units, limit: BigInt(args[3]), escrow: maxTopUp, budget: 0n, deadline: to.settleCount + Number(args[5]), block: blockAt(spec, t), rollFrom: from.id });
        return;
      }
      case "bid": {
        const p = poolOrRevert(net, args[0], fn);
        if (p.status !== Status.Window) revert("InvalidState", fn);
        const units = BigInt(args[1]);
        const per = BigInt(args[2]);
        const escrow = quoteUp(units, per, scaleOf(p.assetDecimals));
        pull(net, p.quote, me, core, escrow, fn);
        st.orders.push({ pool: p.id, id: st.nextOrderId++, owner: me, side: Side.Bid, units, limit: per, escrow, budget: 0n, deadline: p.settleCount + 1_000, block: blockAt(spec, t) });
        return;
      }
      case "createPoolWithOptions": {
        const key = args[0] as { asset: Address; quote: Address; expiry: B; strike: B; kind: number };
        const id = poolId({ asset: key.asset, quote: key.quote, expiry: BigInt(key.expiry), strike: BigInt(key.strike), kind: key.kind });
        if (st.pools[id]) revert("InvalidPool", fn);
        const e = Number(key.expiry);
        const onGrid = (e - DEMO_GRID.anchor) % DEMO_GRID.period === 0 && e > t && e <= t + DEMO_GRID.period * DEMO_GRID.maxExpiries;
        if (!onGrid || !isGridStrike(BigInt(key.strike), DEMO_GRID.strikeSigDigits)) revert("InvalidParams", fn);
        const at = net.tokens.get(lc(key.asset));
        if (!at || !net.tokens.get(lc(key.quote))) revert("BadToken", fn);
        const band = Number(args[2]);
        let mi = spec.markets.findIndex((m) => lc(m.asset) === lc(key.asset) && lc(m.quote) === lc(key.quote) && m.kind === key.kind);
        if (mi < 0) {
          const ref = Object.keys(spec.refs).find((k) => k === `${at.symbol}/${net.tokens.get(lc(key.quote))!.symbol}`) ?? "";
          const m: MarketSpec = { asset: key.asset, quote: key.quote, kind: key.kind, band, fee: Number(args[1]), graduated: false, strikes: [], days: [], ref, size: spec.markets.find((x) => lc(x.asset) === lc(key.asset))?.size ?? [1, 10], pegged: band === 150, activity: 0.3 };
          spec.markets.push(m);
          st.extraMarkets.push(m);
          mi = spec.markets.length - 1;
        }
        const opts = args[3] as { cadence: number; minFill: B; firstLo: B; firstHi: B };
        st.pools[id] = {
          id,
          asset: key.asset,
          quote: key.quote,
          expiry: e,
          strike: BigInt(key.strike),
          kind: key.kind,
          m: mi,
          tier: 1,
          assetDecimals: at.decimals,
          feeBps: Number(args[1]),
          bandBps: band,
          status: Status.Open,
          settleCount: 0,
          windowEnd: 0n,
          lastPrice: 0n,
          vwapNum: 0n,
          vwapDen: 0n,
          quoteBal: 0n,
          assetBal: 0n,
          volume: 0n,
          noise: 0,
          z: 0,
          minFill: BigInt(opts?.minFill ?? 0n),
          firstLo: BigInt(opts?.firstLo ?? 0n),
          firstHi: BigInt(opts?.firstHi ?? 0n),
          cadence: Number(opts?.cadence ?? 0),
          createdBlock: blockAt(spec, t),
          generated: false,
          rows: [],
        };
        st.graduated[marketId(key.asset, key.quote, key.kind)] ??= false;
        return;
      }
      // demo only: sell C or R before maturity at the market price (lib/demo/sell); a sample trader takes the units
      case "demoSellC":
      case "demoSellR": {
        const p = poolOrRevert(net, args[0], fn);
        if (p.status !== Status.Open || t >= p.expiry) revert("InvalidState", fn);
        const units = BigInt(args[1]);
        const isC = fn === "demoSellC";
        const id = isC ? cTokenId(p.id) : rTokenId(p.id);
        const held = (st.b6909[`${id}|${me}`] ?? 0n) - (isC ? 0n : st.lockedR[`${me}|${lc(p.id)}`] ?? 0n);
        if (units <= 0n || units > held) revert(!isC && units <= (st.b6909[`${id}|${me}`] ?? 0n) ? "Locked" : "InvalidParams", fn);
        const ref = st.refs[spec.markets[p.m]?.ref ?? ""];
        const out = sellOut(units, sellPrice(isC ? "c" : "r", p.lastPrice, ref, quoteDecOf(net, p.quote)), p.assetDecimals);
        if (out === 0n || out < BigInt(args[2] ?? 0n)) revert("InvalidParams", fn);
        st.b6909[`${id}|${me}`] = (st.b6909[`${id}|${me}`] ?? 0n) - units;
        credit(st.b6909, `${id}|${lc(SYN[Number(units % BigInt(SYN.length))]!)}`, units);
        give(net, p.quote, me, out);
        // a sale moves the price a little: selling C lowers it, selling R (a bet the collateral ends above the buy-back price) lifts it
        if (p.lastPrice > 0n) p.lastPrice = mulF(p.lastPrice, isC ? 0.9992 : 1.0004);
        p.noise += isC ? 0.002 : -0.001;
        return;
      }
      // demo only: buy C or R from a sample holder at the market price plus the spread (lib/demo/sell)
      case "demoBuyC":
      case "demoBuyR": {
        const p = poolOrRevert(net, args[0], fn);
        if (p.status !== Status.Open || t >= p.expiry) revert("InvalidState", fn);
        const units = BigInt(args[1]);
        const isC = fn === "demoBuyC";
        const id = isC ? cTokenId(p.id) : rTokenId(p.id);
        const ref = st.refs[spec.markets[p.m]?.ref ?? ""];
        const cost = buyCost(units, sellPrice(isC ? "c" : "r", p.lastPrice, ref, quoteDecOf(net, p.quote)), p.assetDecimals);
        if (units <= 0n || cost === 0n || cost > BigInt(args[2] ?? 0n)) revert("InvalidParams", fn);
        const k = `${lc(p.quote)}|${me}`;
        const bal = st.erc20[k] ?? 0n;
        if (bal < cost) revert("ERC20InsufficientBalance", fn, [me as Address, bal, cost]);
        st.erc20[k] = bal - cost;
        credit(st.b6909, `${id}|${me}`, units);
        // buying C lifts its price a little, buying R lowers C's (the mirror of a sale)
        if (p.lastPrice > 0n) p.lastPrice = mulF(p.lastPrice, isC ? 1.0008 : 0.9996);
        p.noise += isC ? -0.002 : 0.001;
        return;
      }
      case "setOperator":
        st.operators[`${me}|${lc(args[0])}`] = !!args[1];
        return;
      case "settleBatch":
        return revert("BatchNotReady", fn);
      case "mature": {
        const p = poolOrRevert(net, args[0], fn);
        if (p.status !== Status.Open || t < p.expiry) revert("InvalidState", fn);
        advance(net, t);
        return;
      }
      case "closeWindow": {
        const p = poolOrRevert(net, args[0], fn);
        if (p.status !== Status.Window || BigInt(blockAt(spec, t)) < p.windowEnd) revert("InvalidState", fn);
        p.status = Status.Closed;
        dropOrders(net, p, () => true);
        return;
      }
      case "purge": {
        const p = poolOrRevert(net, args[0], fn);
        const ids = new Set((args[1] as B[]).map(Number));
        dropOrders(net, p, (x) => ids.has(x.id) && x.deadline <= p.settleCount);
        return;
      }
      case "graduate":
        revert("InvalidState", fn);
    }
    revert("InvalidState", fn);
  }
  if (d.router && a === lc(d.router) && fn === "claimMany") {
    for (const pid of args[0] as string[]) {
      const p = poolOrRevert(net, pid, "claim");
      claimPool(net, p, me, "claim");
    }
    return;
  }
  if (d.seatRegistry && a === lc(d.seatRegistry)) return seatWrite(net, me, fn, args, t);
  const v = st.vaults[a];
  if (v) return vaultWrite(net, v, me, fn, args, t);
  if (a === lc(d.wrapperFactory) && fn === "create") {
    const id = BigInt(args[0]).toString();
    st.wrappers[id] ??= `0xd3a0${BigInt(args[0]).toString(16).padStart(64, "0").slice(-36)}` as Address;
    return;
  }
  const wrapId = Object.entries(st.wrappers).find(([, x]) => lc(x) === a)?.[0];
  if (wrapId) {
    const amt = BigInt(args[0]);
    const to = lc(args[1] ?? me);
    if (fn === "wrap") {
      burn6909(net, BigInt(wrapId), me, amt, fn);
      st.supply6909[wrapId] = (st.supply6909[wrapId] ?? 0n) + amt; // still outstanding, now inside the wrapper
      credit(st.wrapped, `${wrapId}|${to}`, amt);
      return;
    }
    if (fn === "unwrap") {
      const k = `${wrapId}|${me}`;
      if ((st.wrapped[k] ?? 0n) < amt) revert("InsufficientBalance", fn);
      st.wrapped[k] = (st.wrapped[k] ?? 0n) - amt;
      credit(st.b6909, `${wrapId}|${to}`, amt);
      return;
    }
  }
  const tk = net.tokens.get(a);
  if (tk) {
    if (fn === "approve") {
      st.allowance[`${a}|${me}|${lc(args[0])}`] = BigInt(args[1]);
      return;
    }
    if (fn === "deposit") {
      const value = w.value ?? 0n;
      const have = st.native[me] ?? 0n;
      if (have < value) revert("ERC20InsufficientBalance", fn, [me, have, value]);
      st.native[me] = have - value;
      give(net, a, me, value);
      return;
    }
    if (fn === "withdraw" && args.length === 1) {
      // WETH9-style unwrap of the wrapped coin (WHYPE / WMON): the token back into the wallet's coin, 1:1
      const bal = st.erc20[`${a}|${me}`] ?? 0n;
      const amt = BigInt(args[0]);
      if (bal < amt) revert("ERC20InsufficientBalance", fn, [me, bal, amt]);
      st.erc20[`${a}|${me}`] = bal - amt;
      st.native[me] = (st.native[me] ?? 0n) + amt;
      return;
    }
    if (fn === "mint") {
      give(net, a, args[0], BigInt(args[1]));
      return;
    }
    if (fn === "transfer") {
      const bal = st.erc20[`${a}|${me}`] ?? 0n;
      const amt = BigInt(args[1]);
      if (bal < amt) revert("ERC20InsufficientBalance", fn, [me, bal, amt]);
      st.erc20[`${a}|${me}`] = bal - amt;
      give(net, a, args[0], amt);
      return;
    }
  }
  throw new Error(`demo: ${fn} is not available in the demo`);
}

function claimPool(net: Net, p: PoolS, me: Address, fn: string) {
  const { st } = net;
  if (p.status !== Status.Closed) revert("InvalidState", fn);
  const cid = cTokenId(p.id);
  const c = st.b6909[`${cid}|${me}`] ?? 0n;
  const supply = st.supply6909[cid.toString()] ?? 0n;
  if (c === 0n || supply === 0n) return;
  const q = (p.quoteBal * c) / supply;
  const x = (p.assetBal * c) / supply;
  burn6909(net, cid, me, c, fn);
  p.quoteBal -= q;
  p.assetBal -= x;
  give(net, p.quote, me, q);
  give(net, p.asset, me, x);
}

function seatWrite(net: Net, me: Address, fn: string, args: any[], t: number) {
  const { st, spec } = net;
  const reg = lc(demoDeploymentOf(spec.id)!.seatRegistry!);
  if (fn === "withdraw") {
    const k = `${lc(args[0])}|${me}`;
    const amt = st.seatClaimable[k] ?? 0n;
    st.seatClaimable[k] = 0n;
    give(net, args[0], me, amt);
    return;
  }
  if (fn === "postOrder") {
    const p = poolOrRevert(net, args[0], fn);
    const mid = marketId(p.asset, p.quote, p.kind);
    const s = st.seats[mid];
    if (!s || lc(s.holder) !== me) revert("NotHolder", fn);
    const q = args[1] as { side: number; units: B; limit: B };
    const sc = scaleOf(p.assetDecimals);
    const lend = q.side === Side.Buy;
    const escrow = lend ? buyEscrow(q.units, q.limit, 2, sc) : q.units;
    pull(net, lend ? p.quote : p.asset, me, reg, escrow, fn);
    st.orders.push({ pool: p.id, id: st.nextOrderId++, owner: me, side: q.side, units: q.units, limit: q.limit, escrow, budget: 0n, deadline: p.settleCount + 2, block: blockAt(spec, t), locked: true });
    s.lastQuotedBatch = st.round;
    return;
  }
  if (fn === "slash") revert("NotMissed", fn);
  const [asset, quote, kind] = args as [Address, Address, number];
  const mid = seatKey(asset, quote, Number(kind));
  const qd = quoteDecOf(net, quote);
  const ob = toUnits(spec.obligation[lc(quote)] ?? 0, qd);
  let s = st.seats[mid];
  const settleTax = (x: SeatS) => {
    const owed = seatTax(x, TAX_BPS, t);
    x.deposit -= owed;
    x.lastTax = t;
    st.marketFees[mid] = st.marketFees[mid] ?? 0n;
  };
  switch (fn) {
    case "buy": {
      const [, , , newPrice, deposit, maxPay] = args as [Address, Address, number, B, B, B];
      const vacant = !s || s.holder === zeroAddress;
      if (!vacant) settleTax(s!);
      const toHolder = vacant ? 0n : s!.price;
      const bond = ob / 10n;
      const total = toHolder + BigInt(deposit) + bond;
      if (total > BigInt(maxPay)) revert("InvalidParams", fn);
      pull(net, quote, me, reg, total, fn);
      if (!vacant) credit(st.seatClaimable, `${lc(quote)}|${lc(s!.holder)}`, toHolder + s!.deposit + s!.bond);
      s = st.seats[mid] = { holder: me, price: BigInt(newPrice), deposit: BigInt(deposit), bond, lastTax: t, priceLockedUntil: t + 7 * DAY, lastQuotedBatch: st.round };
      return;
    }
    case "setPrice": {
      if (!s || s.holder === zeroAddress) revert("NoSeat", fn);
      if (lc(s.holder) !== me) revert("NotHolder", fn);
      const np = BigInt(args[3]);
      if (np < s.price && t < s.priceLockedUntil) revert("Cooldown", fn);
      settleTax(s);
      s.price = np;
      s.priceLockedUntil = t + 7 * DAY;
      return;
    }
    case "topUp": {
      if (!s || s.holder === zeroAddress) revert("NoSeat", fn);
      if (lc(s.holder) !== me) revert("NotHolder", fn);
      const amt = BigInt(args[3]);
      pull(net, quote, me, reg, amt, fn);
      settleTax(s);
      s.deposit += amt;
      return;
    }
    case "release": {
      if (!s || s.holder === zeroAddress) revert("NoSeat", fn);
      if (lc(s.holder) !== me) revert("NotHolder", fn);
      settleTax(s);
      credit(st.seatClaimable, `${lc(quote)}|${me}`, s.deposit + s.bond);
      st.seats[mid] = { holder: zeroAddress, price: 0n, deposit: 0n, bond: 0n, lastTax: 0, priceLockedUntil: 0, lastQuotedBatch: 0 };
      st.orders = st.orders.filter((o) => !(o.locked && lc(o.owner) === me && st.pools[o.pool] && marketId(st.pools[o.pool]!.asset, st.pools[o.pool]!.quote, st.pools[o.pool]!.kind) === mid));
      return;
    }
    case "split": {
      const fees = st.marketFees[mid] ?? 0n;
      const done = st.feesSplit[mid] ?? 0n;
      const fresh = sub0(fees, done);
      st.feesSplit[mid] = fees;
      if (s && s.holder !== zeroAddress) credit(st.seatClaimable, `${lc(quote)}|${lc(s.holder)}`, (fresh * BigInt(SHARE_BPS)) / 10_000n);
      return;
    }
  }
  throw new Error(`demo: ${fn} is not available in the demo`);
}

function vaultWrite(net: Net, v: VaultS, me: Address, fn: string, args: any[], t: number) {
  const acct = vaultAcct(v, me);
  switch (fn) {
    case "requestDeposit": {
      const amt = BigInt(args[0]);
      if (amt <= 0n) revert("InvalidParams", fn);
      pull(net, v.quote, me, v.address, amt, fn);
      acct.pendingDeposit += amt;
      v.pendingDepositAssets += amt;
      return;
    }
    case "requestRedeem": {
      const sh = BigInt(args[0]);
      if (sh <= 0n || sh > acct.shares) revert("InvalidParams", fn);
      acct.shares -= sh;
      acct.pendingRedeem += sh;
      v.pendingRedeemShares += sh;
      return;
    }
    case "mint": {
      const sh = BigInt(args[0]);
      if (sh > acct.claimShares) revert("NotReady", fn);
      acct.claimShares -= sh;
      acct.shares += sh;
      v.supply += sh;
      v.ta += acct.claimableDeposit;
      acct.claimableDeposit = 0n;
      return;
    }
    case "withdraw": {
      const amt = BigInt(args[0]);
      if (amt > acct.claimAssets) revert("NotReady", fn);
      acct.claimAssets -= amt;
      v.supply = sub0(v.supply, acct.claimableRedeem);
      v.ta = sub0(v.ta, amt);
      acct.claimableRedeem = 0n;
      give(net, v.quote, me, amt);
      return;
    }
    case "claimAssets": {
      for (const [tk, x] of Object.entries(acct.credits)) give(net, tk, me, x);
      acct.credits = {};
      return;
    }
    case "approve":
      return;
  }
  void t;
  revert("AsyncOnly", fn);
}

/** The deployment's live pools must never be read in demo mode; exported for tests that check the seam. */
export const _liveDeployments = deployments;
