/**
 * Adapter for core v0.8 reads whose ABIs are not regenerated into @confluere/sdk yet (BLUEPRINT v0.8 §8, §10;
 * contracts commit 8549262). Once `pnpm codegen` runs against the v0.8 core, replace these fragments with
 * `confluereAbi` and delete this file; the shapes below match IConfluere.sol.
 *
 * The live testnet cores predate v0.8, so every reader here falls back to the pre-v0.8 shape (vwap, graduation by
 * volume) when the v0.8 call reverts.
 */
import { parseAbi } from "viem";

export const v08Abi = parseAbi([
  "function graduationFee(address quote) view returns (uint256)",
  "function graduationVolume(address quote) view returns (uint256)",
  "struct MarketStats08 { uint128 volume; uint128 fees; uint96 minStrike; uint96 maxStrike; bool bad; }",
  "function marketStats(bytes32 marketId, uint64 expiry) view returns (MarketStats08)",
]);

export const v07StatsAbi = parseAbi([
  "struct MarketStats07 { uint128 volume; uint96 minStrike; uint96 maxStrike; bool bad; }",
  "function marketStats(bytes32 marketId, uint64 expiry) view returns (MarketStats07)",
]);

/** v0.8 PoolView fields, read defensively from a decoded view (absent on a pre-v0.8 core: zero). */
export function feeFields(v: Record<string, unknown>): { feeEscrow: bigint; filledUnits: bigint; repaidUnits: bigint } {
  const b = (x: unknown) => (typeof x === "bigint" ? x : 0n);
  return { feeEscrow: b(v.feeEscrow), filledUnits: b(v.filledUnits), repaidUnits: b(v.repaidUnits) };
}

/** Graduation basis: "fees" on a v0.8 core (MarketStats.fees vs graduationFee), "volume" on an older one. */
export type GraduationBasis = "fees" | "volume";
