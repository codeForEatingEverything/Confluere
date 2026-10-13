import { encodeAbiParameters, type Address, type Hex } from "viem";

/** Report body KeeperReceiver.onReport expects: abi.encode(bytes32[] pools, address[] vaults). */
export function encodeTick(pools: readonly Hex[], vaults: readonly Address[]): Hex {
  return encodeAbiParameters([{ type: "bytes32[]" }, { type: "address[]" }], [pools, vaults]);
}
