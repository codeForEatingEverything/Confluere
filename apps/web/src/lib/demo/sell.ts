/**
 * Selling C or R before maturity in the demo (IA v3.1 item 13). The live app has no secondary market yet ("Secondary
 * market coming soon"); the demo fills the sale at a market price so the flow can be tried. Pure, shared by the trade
 * card (what you receive) and the sample network (what it pays), so both agree.
 *
 * One unit of collateral is one C plus one R (C pays the buy-back price or the collateral at maturity, R buys the
 * collateral back at that price), so: C is worth its last traded price, R the reference price minus that, never below
 * zero. A sale gives up a small spread (0.5%).
 */
import { scaleOf } from "@confluere/sdk";

export type SellToken = "c" | "r";

export const DEMO_SELL_FN = { c: "demoSellC", r: "demoSellR" } as const;
/** Buying C or R from a sample holder at the same market price, plus the spread. */
export const DEMO_BUY_FN = { c: "demoBuyC", r: "demoBuyR" } as const;
const SPREAD_BPS = 50n;

/** Price of one unit in quote base units (0 when there is no price). `ref` is quote per 1 collateral (display units). */
export function sellPrice(token: SellToken, lastPrice: bigint, ref: number | null | undefined, quoteDecimals: number): bigint {
  if (lastPrice <= 0n) return 0n;
  if (token === "c") return lastPrice;
  if (!ref || !Number.isFinite(ref) || ref <= 0) return 0n;
  const refUnits = BigInt(Math.floor(ref * 10 ** Math.min(quoteDecimals, 12))) * 10n ** BigInt(Math.max(0, quoteDecimals - 12));
  return refUnits > lastPrice ? refUnits - lastPrice : 0n;
}

/** Quote base units received for `units` of C or R at `per`, after the spread (rounded down). */
export function sellOut(units: bigint, per: bigint, assetDecimals: number): bigint {
  if (units <= 0n || per <= 0n) return 0n;
  return (units * per * (10_000n - SPREAD_BPS)) / (scaleOf(assetDecimals) * 10_000n);
}

/** The least the sale may pay (1% below the quote shown), so a price move between quote and signature is bounded. */
export const sellMinOut = (out: bigint) => (out * 99n) / 100n;

/** Quote base units paid for `units` of C or R at `per`, spread included (rounded up against the buyer). */
export function buyCost(units: bigint, per: bigint, assetDecimals: number): bigint {
  if (units <= 0n || per <= 0n) return 0n;
  const d = scaleOf(assetDecimals) * 10_000n;
  return (units * per * (10_000n + SPREAD_BPS) + d - 1n) / d;
}

/** The most the purchase may cost (1% above the quote shown). */
export const buyMaxIn = (cost: bigint) => (cost * 101n) / 100n;
