import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { Kind, type PoolKey } from "./types.js";

const KEY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "asset", type: "address" },
      { name: "quote", type: "address" },
      { name: "expiry", type: "uint64" },
      { name: "strike", type: "uint128" },
      { name: "kind", type: "uint8" },
      { name: "bandBps", type: "uint16" },
      { name: "cadence", type: "uint8" },
    ],
  },
] as const;

const LOW_BIT = 1n;

/** keccak256(abi.encode(key)) with the lowest bit cleared, exactly as PoolKeyLib.toId. */
export function poolId(key: PoolKey): Hex {
  const h = BigInt(keccak256(encodeAbiParameters(KEY_ABI, [key])));
  return `0x${(h & ~LOW_BIT).toString(16).padStart(64, "0")}`;
}

/** ERC-6909 id of the lender's C-Token. */
export const cTokenId = (pid: Hex): bigint => BigInt(pid);

/** ERC-6909 id of the borrower's R-Token. */
export const rTokenId = (pid: Hex): bigint => BigInt(pid) | LOW_BIT;

export function marketId(asset: Hex, quote: Hex, kind: Kind): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint8" }],
      [asset, quote, kind],
    ),
  );
}

/** A tier of a market at one expiry: strike | bandBps << 128 | cadence << 144, as PoolKeyLib.tierKey. */
export const tierKey = (strike: bigint, bandBps: number, cadence: number): bigint =>
  strike | (BigInt(bandBps) << 128n) | (BigInt(cadence) << 144n);
