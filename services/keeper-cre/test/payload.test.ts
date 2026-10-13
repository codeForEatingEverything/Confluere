import { describe, expect, it } from "vitest";
import { decodeAbiParameters } from "viem";
import { encodeTick } from "../src/payload";

describe("CRE report payload", () => {
  it("round-trips as (bytes32[], address[]) for KeeperReceiver.onReport", () => {
    const pools = ["0x" + "11".repeat(32), "0x" + "22".repeat(32)] as const;
    const vaults = ["0x00000000000000000000000000000000000000aa"] as const;
    const [p, v] = decodeAbiParameters([{ type: "bytes32[]" }, { type: "address[]" }], encodeTick(pools, vaults));
    expect(p).toEqual(pools);
    expect(v.map((a) => a.toLowerCase())).toEqual(vaults);
  });
});
