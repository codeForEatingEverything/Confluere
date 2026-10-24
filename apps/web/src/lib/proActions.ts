/**
 * Transaction builders for the More pages (Markets pro view, Seats, Open a market, Developers). They live here so the
 * screens only speak the user vocabulary; the contract names (settleBatch, mature, closeWindow, purge, bid, postOrder,
 * createPoolWithOptions…) appear only in this file and in the Developers code sample.
 */
import { Side, buyEscrow, confluereAbi, repayAmount, scaleOf, seatRegistryAbi, vaultAbi, type Kind } from "@confluere/sdk";
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import type { PoolRow, Token, VaultRow } from "./data";
import type { Action } from "./due";
import type { Write } from "./tx";

/** Plain names for what a market needs next (all permissionless; the keeper usually does them). */
export const ADVANCE_LABEL: Record<Action, string> = {
  settle: "Run this round",
  mature: "Mark matured",
  close: "Close",
  purge: "Clean up expired orders",
  none: "Nothing to do",
};

export function advanceWrite(core: Address, p: Pick<PoolRow, "id">, a: Action, dead: bigint[] = []): Write | undefined {
  if (a === "settle") return { label: ADVANCE_LABEL.settle, address: core, abi: confluereAbi, functionName: "settleBatch", args: [p.id] };
  if (a === "mature") return { label: ADVANCE_LABEL.mature, address: core, abi: confluereAbi, functionName: "mature", args: [p.id] };
  if (a === "close") return { label: ADVANCE_LABEL.close, address: core, abi: confluereAbi, functionName: "closeWindow", args: [p.id, 32n] };
  if (a === "purge") return { label: ADVANCE_LABEL.purge, address: core, abi: confluereAbi, functionName: "purge", args: [p.id, dead.slice(0, 64)] };
  return undefined;
}

export const vaultAdvanceWrite = (v: Pick<VaultRow, "address">, what: "poke" | "roll"): Write => ({
  label: what === "poke" ? "Lend this round" : "Start the next period",
  address: v.address,
  abi: vaultAbi,
  functionName: what,
  args: [],
});

export const graduateWrite = (core: Address, m: { asset: Address; quote: Address; kind: Kind }, lastExpiry: number): Write => ({
  label: "Mark established",
  address: core,
  abi: confluereAbi,
  functionName: "graduate",
  args: [m.asset, m.quote, m.kind, BigInt(lastExpiry)],
});

const hint = async (client: PublicClient, core: Address, pid: Hex, side: Side, limit: bigint) =>
  (await client.readContract({ address: core, abi: confluereAbi, functionName: "findHint", args: [pid, side, limit] })) as bigint;

/** Quote held for an offer on unclaimed units: units × (buy-back + extra per unit). */
export const offerHeld = (p: Pick<PoolRow, "strike" | "assetDecimals">, units: bigint, extra: bigint) => repayAmount(units, p.strike + extra, scaleOf(p.assetDecimals));

/** Offer for units nobody repaid, during the repayment window (a borrower who repays in time always wins). */
export async function offerWrites(o: { client: PublicClient; core: Address; ensureAllowance: (t: Address, a: bigint, s?: Address, x?: { symbol?: string }) => Promise<Write | null> }, p: PoolRow, units: bigint, extra: bigint, quote: Token): Promise<Write[]> {
  const build = async (): Promise<Write> => ({ label: "Offer", address: o.core, abi: confluereAbi, functionName: "bid", args: [p.id, units, extra, await hint(o.client, o.core, p.id, Side.Bid, extra)], refresh: build, token: quote });
  const a = await o.ensureAllowance(p.quote, offerHeld(p, units, extra), o.core, { symbol: quote.symbol });
  return [a, await build()].filter((x): x is Write => !!x);
}

// ───────────────────────────── seats ─────────────────────────────

const reg = (registry: Address, label: string, functionName: string, args: unknown[], token?: Token, copy?: Record<string, string>): Write => ({ label, address: registry, abi: seatRegistryAbi, functionName, args, token, copy });

export type SeatKey = { asset: Address; quote: Address; kind: Kind };

export const seatBuyWrite = (r: Address, m: SeatKey, price: bigint, deposit: bigint, pay: bigint, quote: Token) => reg(r, "Buy seat", "buy", [m.asset, m.quote, m.kind, price, deposit, pay], quote);
export const seatPriceWrite = (r: Address, m: SeatKey, price: bigint, quote: Token, until: string) => reg(r, "Set price", "setPrice", [m.asset, m.quote, m.kind, price], quote, { Cooldown: `The price cannot be lowered until ${until}.` });
export const seatTopUpWrite = (r: Address, m: SeatKey, amount: bigint, quote: Token) => reg(r, "Top up", "topUp", [m.asset, m.quote, m.kind, amount], quote);
export const seatReleaseWrite = (r: Address, m: SeatKey) => reg(r, "Release seat", "release", [m.asset, m.quote, m.kind]);
export const seatSplitWrite = (r: Address, m: SeatKey) => reg(r, "Share out fees", "split", [m.asset, m.quote, m.kind]);
export const seatWithdrawWrite = (r: Address, quote: Address) => reg(r, "Claim fees", "withdraw", [quote]);
export const seatReportWrite = (r: Address, evidence: Pick<PoolRow, "id">) => reg(r, "Report a missed round", "slash", [evidence.id]);

/** Quote this round: a seat order (a price to borrow or lend at), locked until it can no longer fill; kept for 2 rounds. */
export async function seatQuoteWrite(client: PublicClient, core: Address, r: Address, p: PoolRow, lend: boolean, units: bigint, limit: bigint): Promise<Write> {
  const side = lend ? Side.Buy : Side.Sell;
  const build = async (): Promise<Write> => ({
    ...reg(r, "Quote this round", "postOrder", [p.id, { side, units, limit, budget: 0n, ttl: 2, hint: await hint(client, core, p.id, side, limit), owner: zeroAddress }], undefined, {
      InvalidParams: "Outside the seat rules: the price is too far from last traded, or the size is below the seat's minimum.",
    }),
    refresh: build,
  });
  return build();
}

/** What a seat quote holds: the collateral (borrow side) or the quote for 2 rounds at the price (lend side). */
export const seatQuoteHeld = (p: Pick<PoolRow, "assetDecimals">, lend: boolean, units: bigint, limit: bigint) => (lend ? buyEscrow(units, limit, 2, scaleOf(p.assetDecimals)) : units);

// ───────────────────────────── open a market ─────────────────────────────

export type NewMarket = {
  asset: Address;
  quote: Address;
  expiry: number;
  buyBack: bigint;
  kind: Kind;
  feeBps: number;
  guardBps: number;
  /** v0.8 PoolOptions.autoSell; the pre-v0.8 createPool ABI has no slot for it, so it is sent once the SDK is regenerated. */
  autoSell?: boolean;
  slow: number;
  minVolume: bigint;
  firstLow: bigint;
  firstHigh: bigint;
};

/** v0.8 PoolKey: band and cadence are part of the pool id (V08 spec §2.3). */
export const marketKey = (m: Pick<NewMarket, "asset" | "quote" | "expiry" | "buyBack" | "kind" | "guardBps" | "slow">) => ({ asset: m.asset, quote: m.quote, expiry: BigInt(m.expiry), strike: m.buyBack, kind: m.kind, bandBps: m.guardBps, cadence: m.slow });

export const openMarketWrite = (core: Address, m: NewMarket): Write => ({
  label: "Open market",
  address: core,
  abi: confluereAbi,
  functionName: "createPoolWithOptions",
  args: [marketKey(m), m.feeBps, m.guardBps, { cadence: m.slow, minFill: m.minVolume, firstLo: m.firstLow, firstHi: m.firstHigh }],
  copy: { InvalidPool: "A market with these exact terms already exists. Open it instead." },
});
