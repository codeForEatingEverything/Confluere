import { describe, expect, it } from "vitest";
import { decode, encode } from "@msgpack/msgpack";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Hex } from "viem";
import { hlPrice, l1ActionHash, signL1Action, signSpotSend, systemAddress } from "../src/hyperliquid";

// anvil key 0: test-only
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const join = (s: { r: Hex; s: Hex; v: number }) => `${s.r}${s.s.slice(2)}${s.v.toString(16)}` as Hex;

describe("hyperliquid signing", () => {
  it("system addresses: HYPE 0x2222…, others 0x20 + index", () => {
    expect(systemAddress({ name: "HYPE", index: 1105 })).toBe("0x2222222222222222222222222222222222222222");
    expect(systemAddress({ name: "USDC", index: 0 })).toBe("0x2000000000000000000000000000000000000000");
    expect(systemAddress({ name: "X", index: 200 })).toBe("0x20000000000000000000000000000000000000c8");
  });

  it("spotSend signature recovers to the signer", async () => {
    const b = await signSpotSend(account, "Testnet", { destination: "0x2222222222222222222222222222222222222222", token: "HYPE:0x7317beb7cceed72ef0b346074cc8e7ab", amount: "1", time: 1_700_000_000_000 });
    const signer = await recoverTypedDataAddress({
      domain: { name: "HyperliquidSignTransaction", version: "1", chainId: 421614, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { "HyperliquidTransaction:SpotSend": [{ name: "hyperliquidChain", type: "string" }, { name: "destination", type: "string" }, { name: "token", type: "string" }, { name: "amount", type: "string" }, { name: "time", type: "uint64" }] },
      primaryType: "HyperliquidTransaction:SpotSend",
      message: { hyperliquidChain: "Testnet", destination: b.action.destination, token: b.action.token, amount: "1", time: 1_700_000_000_000n },
      signature: join(b.signature),
    });
    expect(signer).toBe(account.address);
    expect(b.action.signatureChainId).toBe("0x66eee");
  });

  it("L1 action hash covers msgpack(action) in key order, the nonce and the vault flag", async () => {
    const h1 = l1ActionHash({ type: "evmUserModify", usingBigBlocks: true }, 1);
    expect(h1).not.toBe(l1ActionHash({ type: "evmUserModify", usingBigBlocks: false }, 1));
    expect(h1).not.toBe(l1ActionHash({ type: "evmUserModify", usingBigBlocks: true }, 2));
    const b = await signL1Action(account, "Testnet", { type: "evmUserModify", usingBigBlocks: true }, 1);
    const signer = await recoverTypedDataAddress({
      domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      primaryType: "Agent",
      message: { source: "b", connectionId: h1 },
      signature: join(b.signature),
    });
    expect(signer).toBe(account.address);
    expect(decode(encode(b.action))).toEqual({ type: "evmUserModify", usingBigBlocks: true });
  });
});

describe("hlPrice", () => {
  it("keeps 5 significant figures and at most 8 - szDecimals decimals", () => {
    expect(hlPrice(21.37654, 2)).toBe("21.377");
    expect(hlPrice(0.000123456, 0)).toBe("0.00012346");
    expect(hlPrice(1234567, 2)).toBe("1234600");
  });
});
