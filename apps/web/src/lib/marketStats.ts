/**
 * Numbers for the Stats blocks of the market and LP pages (IA v3.1 items 8 and 9), pure.
 *
 * Locked value = what the pool contracts hold now: the quote waiting in them plus the collateral, the collateral valued
 * at the display-only reference price (never used by the contracts). Without a reference price only the quote part and
 * the collateral amount are known, so the value is left out.
 */
import { scaleOf } from "@confluere/sdk";
import type { PoolRow } from "./data";

export type Locked = { quote: bigint; asset: bigint; value?: bigint };

export function lockedNow(pools: Pick<PoolRow, "quoteBal" | "assetBal" | "assetDecimals">[], refUnits: bigint | undefined): Locked {
  const quote = pools.reduce((s, p) => s + p.quoteBal, 0n);
  const asset = pools.reduce((s, p) => s + p.assetBal, 0n);
  const d = pools[0]?.assetDecimals ?? 18;
  return { quote, asset, value: refUnits !== undefined ? quote + (asset * refUnits) / scaleOf(d) : undefined };
}
