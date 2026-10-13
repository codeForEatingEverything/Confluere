/**
 * Transaction builders for the main path, one function per user action. Each returns the writes for
 * `useTx().run(() => …)` (approval first when needed); `run` simulates every write before the wallet opens and makes
 * sure the wallet is on the active chain. Labels are the plain words shown in the step list.
 *
 *   const tx = useTx(); const ctx = useActionCtx();
 *   tx.run(() => borrowWrites(ctx!, { pool, units, asset }))
 */
import { Side, buyEscrow, confluereAbi, repayAmount, scaleOf, vaultAbi } from "@confluere/sdk";
import { zeroAddress, type Address, type PublicClient } from "viem";
import type { PoolRow, Token } from "./data";
import { defaultCap, defaultTtl } from "./order";
import { rolloverMaxTopUp, rolloverTries, rolloverTtl } from "./rollover";
import type { Tx, Write } from "./tx";
import { unwrapWrite, wrapWrite } from "./tokens";

export type ActionCtx = {
  client: PublicClient;
  core: Address;
  account: Address;
  windowBlocks: number;
  ensureAllowance: Tx["ensureAllowance"];
};

const BPS = 10_000n;

const hintFor = async (ctx: ActionCtx, pool: PoolRow, side: Side, limit: bigint): Promise<bigint> =>
  (await ctx.client.readContract({ address: ctx.core, abi: confluereAbi, functionName: "findHint", args: [pool.id, side, limit] })) as bigint;

const compact = (xs: (Write | null | undefined)[]) => xs.filter((x): x is Write => !!x);

/**
 * Paying in the native coin (IA v3.1 item 11): the wrap into WHYPE / WMON is the first step of the same action. `native`
 * is the coin's symbol ("HYPE" / "MON"); nothing is wrapped when it is undefined.
 */
const wrapFirst = (native: string | undefined, token: Address, amount: bigint): Write | null => (native && amount > 0n ? wrapWrite(token, amount, native) : null);

/** Default price tolerance for an at-price order: 1%, or the pool's band when tighter (pegged pools 1.5% → 1%). */
export const defaultSlippageBps = (p: Pick<PoolRow, "bandBps">) => Math.min(100, p.bandBps);

export type BorrowInput = {
  pool: PoolRow;
  /** Collateral units to sell. */
  units: bigint;
  asset: Token;
  /**
   * "at-price" (default): fills at the next batch's price as long as it is not below `price × (1 − slippage)`.
   * "limit": a fixed minimum price per whole collateral (`limit`), the only way into a pool that never traded.
   */
  mode?: "at-price" | "limit";
  limit?: bigint;
  slippageBps?: number;
  ttl?: number;
  /** Same as ttl, in the UI's words: rounds the order keeps trying. */
  rounds?: number;
  /** Pay in the native coin (its symbol): wrap the collateral first. Only for a market whose collateral is WHYPE / WMON. */
  payNative?: string;
};

/** The minimum price an at-price borrow accepts (0 when the pool never traded: use a limit instead). */
export function borrowFloor(p: Pick<PoolRow, "lastClearingPrice" | "bandBps">, slippageBps = defaultSlippageBps(p)): bigint {
  return (p.lastClearingPrice * (BPS - BigInt(slippageBps))) / BPS;
}

/** Borrow = sell collateral into the pool for quote now; the buy-back right arrives when the batch fills. */
export async function borrowWrites(ctx: ActionCtx, i: BorrowInput): Promise<Write[]> {
  const atPrice = (i.mode ?? "at-price") === "at-price" && i.pool.lastClearingPrice > 0n;
  const limit = atPrice ? borrowFloor(i.pool, i.slippageBps) : (i.limit ?? 0n);
  if (!atPrice && limit === 0n) throw new Error("This pool has no price yet: set the minimum you accept per unit.");
  const side = atPrice ? Side.NcSell : Side.Sell;
  const ttl = i.ttl ?? i.rounds ?? defaultTtl(i.pool);
  const build = async (): Promise<Write> => ({
    label: "Borrow",
    address: ctx.core,
    abi: confluereAbi,
    functionName: "placeOrder",
    args: [i.pool.id, { side, units: i.units, limit, budget: 0n, ttl, hint: atPrice ? 0n : await hintFor(ctx, i.pool, side, limit), owner: zeroAddress }],
    refresh: atPrice ? undefined : build,
    token: i.asset,
  });
  return compact([wrapFirst(i.payNative, i.pool.asset, i.units), await ctx.ensureAllowance(i.pool.asset, i.units, ctx.core, { symbol: i.asset.symbol }), await build()]);
}

export type LendInput = {
  pool: PoolRow;
  /** Quote to lend. */
  amount: bigint;
  quote: Token;
  /** "at-price" (default): spend `amount` at the next batch's price, never above the cap. "limit": `units` at `limit`. */
  mode?: "at-price" | "limit";
  limit?: bigint;
  units?: bigint;
  slippageBps?: number;
  ttl?: number;
  /** Same as ttl, in the UI's words: rounds the order keeps trying. */
  rounds?: number;
  /** Pay in the native coin (its symbol): wrap what the order holds first. Only for a market priced in WHYPE / WMON. */
  payNative?: string;
};

/** The highest price an at-price lend accepts: the last price + slippage, never above the vaults' cap (99% / 99.5% of the buy-back). */
export function lendCap(p: Pick<PoolRow, "lastClearingPrice" | "strike" | "bandBps">, slippageBps = defaultSlippageBps(p)): bigint {
  const cap = defaultCap(p);
  if (p.lastClearingPrice === 0n) return cap;
  const up = (p.lastClearingPrice * (BPS + BigInt(slippageBps))) / BPS;
  return up < cap ? up : cap;
}

/** Lend = buy lender units below the buy-back price; paid the buy-back price per unit if repaid, else the collateral. */
export async function lendWrites(ctx: ActionCtx, i: LendInput): Promise<Write[]> {
  const ttl = i.ttl ?? i.rounds ?? defaultTtl(i.pool);
  const scale = scaleOf(i.pool.assetDecimals);
  const atPrice = (i.mode ?? "at-price") === "at-price";
  if (atPrice) {
    const limit = lendCap(i.pool, i.slippageBps);
    const w: Write = {
      label: "Lend",
      address: ctx.core,
      abi: confluereAbi,
      functionName: "placeOrder",
      args: [i.pool.id, { side: Side.NcBuy, units: 0n, limit, budget: i.amount, ttl, hint: 0n, owner: zeroAddress }],
      token: i.quote,
    };
    return compact([wrapFirst(i.payNative, i.pool.quote, i.amount), await ctx.ensureAllowance(i.pool.quote, i.amount, ctx.core, { symbol: i.quote.symbol }), w]);
  }
  const limit = i.limit ?? 0n;
  const units = i.units ?? 0n;
  if (limit === 0n || units === 0n) throw new Error("Set the price and amount to lend.");
  const escrow = buyEscrow(units, limit, ttl, scale);
  const build = async (): Promise<Write> => ({
    label: "Lend",
    address: ctx.core,
    abi: confluereAbi,
    functionName: "placeOrder",
    args: [i.pool.id, { side: Side.Buy, units, limit, budget: 0n, ttl, hint: await hintFor(ctx, i.pool, Side.Buy, limit), owner: zeroAddress }],
    refresh: build,
    token: i.quote,
  });
  return compact([wrapFirst(i.payNative, i.pool.quote, escrow), await ctx.ensureAllowance(i.pool.quote, escrow, ctx.core, { symbol: i.quote.symbol }), await build()]);
}

/** Repay = buy the collateral back at the buy-back price (any time in American pools, in the window for all). */
/** `receiveNative` (the coin's symbol): the WHYPE / WMON collateral that comes back is unwrapped to HYPE / MON right after. */
export async function repayWrites(ctx: ActionCtx, i: { pool: PoolRow; units: bigint; quote: Token; payNative?: string; receiveNative?: string }): Promise<Write[]> {
  const pay = repayAmount(i.units, i.pool.strike, scaleOf(i.pool.assetDecimals));
  return compact([
    wrapFirst(i.payNative, i.pool.quote, pay),
    await ctx.ensureAllowance(i.pool.quote, pay, ctx.core, { symbol: i.quote.symbol }),
    { label: "Repay", address: ctx.core, abi: confluereAbi, functionName: "repay", args: [i.pool.id, i.units], token: i.quote },
    i.receiveNative ? unwrapWrite(i.pool.asset, i.units, i.receiveNative) : null,
  ]);
}

export type RolloverInput = {
  from: PoolRow;
  to: PoolRow;
  units: bigint;
  quote: Token;
  now: number;
  /** Measured seconds per block (useBlockTime); sizes the number of batches the roll-over may try. */
  spb: number | null | undefined;
  /** Minimum price per whole collateral in the new pool; default its last price minus the slippage. */
  minPrice?: bigint;
  slippageBps?: number;
};

/** Parameters a roll-over will use (shown before signing): the floor, the most to top up, the ttl. */
export function rolloverPlan(i: Omit<RolloverInput, "quote">, windowBlocks: number) {
  const minPrice = i.minPrice ?? borrowFloor(i.to, i.slippageBps);
  const tries = rolloverTries(windowBlocks, i.spb, i.to.batchInterval);
  const { ttl, capped } = rolloverTtl({ now: i.now, fromExpiry: i.from.expiry, targetInterval: i.to.batchInterval, tries });
  const maxTopUp = minPrice > 0n ? rolloverMaxTopUp(i.from, i.units, minPrice, ttl) : 0n;
  return { minPrice, maxTopUp, ttl, capped, tries };
}

/** Roll over = carry the loan into a later maturity: the new pool's lenders pay this buy-back, you add any gap. */
export async function rolloverWrites(ctx: ActionCtx, i: RolloverInput): Promise<Write[]> {
  const plan = rolloverPlan(i, ctx.windowBlocks);
  if (plan.minPrice === 0n) throw new Error("The later pool has no price yet: set the minimum you accept per unit.");
  const build = async (): Promise<Write> => ({
    label: "Extend",
    address: ctx.core,
    abi: confluereAbi,
    functionName: "rollover",
    args: [i.from.id, i.to.id, i.units, plan.minPrice, plan.maxTopUp, plan.ttl, await hintFor(ctx, i.to, Side.Sell, plan.minPrice)],
    refresh: build,
    token: i.quote,
  });
  return compact([await ctx.ensureAllowance(i.from.quote, plan.maxTopUp, ctx.core, { symbol: i.quote.symbol }), await build()]);
}

/** Claim after close: lenders get their share of quote and any collateral kept; borrowers any auction surplus. */
export const claimWrite = (ctx: Pick<ActionCtx, "core">, pool: PoolRow): Write => ({
  label: "Claim",
  address: ctx.core,
  abi: confluereAbi,
  functionName: "claim",
  args: [pool.id],
});

/** Withdraw a balance waiting in Confluere (fills, refunds, leftovers) to the wallet. */
export const withdrawWrite = (ctx: Pick<ActionCtx, "core" | "account">, token: Address, symbol?: string): Write => ({
  label: symbol ? `Withdraw ${symbol}` : "Withdraw",
  address: ctx.core,
  abi: confluereAbi,
  functionName: "withdraw",
  args: [token, ctx.account],
});

/** Cancel one of your orders that has not filled yet (escrow goes to Withdraw). */
export const cancelWrite = (ctx: Pick<ActionCtx, "core">, pool: `0x${string}`, orderId: bigint): Write => ({
  label: "Cancel order",
  address: ctx.core,
  abi: confluereAbi,
  functionName: "cancelOrder",
  args: [pool, orderId],
});

// ───────────────────────────── vaults (ERC-7540) ─────────────────────────────

/** Vault deposit: queued until the vault's next roll at maturity, then shares become collectable. */
export async function vaultDepositWrites(ctx: ActionCtx, i: { vault: Address; quote: Token; amount: bigint; payNative?: string }): Promise<Write[]> {
  return compact([
    wrapFirst(i.payNative, i.quote.address, i.amount),
    await ctx.ensureAllowance(i.quote.address, i.amount, i.vault, { symbol: i.quote.symbol }),
    { label: "Deposit", address: i.vault, abi: vaultAbi, functionName: "requestDeposit", args: [i.amount, ctx.account, ctx.account], token: i.quote },
  ]);
}

/** Vault withdrawal request: settles at the vault's next roll (first come first served; may include collateral). */
export const vaultRedeemWrite = (ctx: Pick<ActionCtx, "account">, vault: Address, shares: bigint): Write => ({
  label: "Request withdrawal",
  address: vault,
  abi: vaultAbi,
  functionName: "requestRedeem",
  args: [shares, ctx.account, ctx.account],
});

/** Collect whatever the vault has settled for you: shares from deposits, quote from withdrawals, collateral credits. */
export function vaultCollectWrites(
  ctx: Pick<ActionCtx, "account">,
  vault: Address,
  me: { claimShares: bigint; claimAssets: bigint; assetCredits: { amount: bigint }[] },
  quoteSymbol: string,
  /** A coin vault paid out as the coin: the WHYPE / WMON withdrawn is unwrapped to HYPE / MON right after. */
  unwrap?: { token: Address; native: string },
): Write[] {
  const w: Write[] = [];
  if (me.claimShares > 0n) w.push({ label: "Collect shares", address: vault, abi: vaultAbi, functionName: "mint", args: [me.claimShares, ctx.account, ctx.account] });
  if (me.claimAssets > 0n) w.push({ label: `Withdraw ${unwrap ? unwrap.native : quoteSymbol}`, address: vault, abi: vaultAbi, functionName: "withdraw", args: [me.claimAssets, ctx.account, ctx.account] });
  if (me.claimAssets > 0n && unwrap) w.push(unwrapWrite(unwrap.token, me.claimAssets, unwrap.native));
  if (me.assetCredits.some((c) => c.amount > 0n)) w.push({ label: "Collect tokens", address: vault, abi: vaultAbi, functionName: "claimAssets", args: [ctx.account] });
  return w;
}
