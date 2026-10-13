/**
 * Minimal Hyperliquid exchange signing for the two operations a HyperEVM deployment needs:
 * - spotSend to a token's system address (moves HYPE / USDC from HyperCore to HyperEVM);
 * - evmUserModify { usingBigBlocks } (deploys need the 30M-gas big blocks, ARCHITECTURE §0.1).
 * Formats follow Hyperliquid's documented signing scheme: user-signed actions use the
 * "HyperliquidSignTransaction" EIP-712 domain; L1 actions sign a phantom agent over keccak(msgpack(action) ‖ nonce ‖ vault).
 */
import { encode } from "@msgpack/msgpack";
import { concat, keccak256, numberToHex, toBytes, type Hex, type LocalAccount } from "viem";

export type Network = "Testnet" | "Mainnet";

export const API: Record<Network, string> = {
  Testnet: "https://api.hyperliquid-testnet.xyz",
  Mainnet: "https://api.hyperliquid.xyz",
};

/** HYPE arrives on HyperEVM via 0x2222…; other spot tokens via 0x20 followed by their index (big-endian). */
export function systemAddress(token: { name: string; index: number }): Hex {
  if (token.name === "HYPE") return "0x2222222222222222222222222222222222222222";
  return `0x20${token.index.toString(16).padStart(38, "0")}` as Hex;
}

const SIGNATURE_CHAIN_ID = 421614; // 0x66eee, the chain id Hyperliquid expects in user-signed typed data

function splitSig(sig: Hex) {
  return { r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66, 130)}` as Hex, v: parseInt(sig.slice(130, 132), 16) };
}

export async function signSpotSend(
  account: LocalAccount,
  net: Network,
  p: { destination: Hex; token: string; amount: string; time: number },
) {
  const action = {
    type: "spotSend",
    signatureChainId: numberToHex(SIGNATURE_CHAIN_ID),
    hyperliquidChain: net,
    destination: p.destination.toLowerCase(),
    token: p.token,
    amount: p.amount,
    time: p.time,
  };
  const sig = await account.signTypedData({
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: SIGNATURE_CHAIN_ID, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: {
      "HyperliquidTransaction:SpotSend": [
        { name: "hyperliquidChain", type: "string" },
        { name: "destination", type: "string" },
        { name: "token", type: "string" },
        { name: "amount", type: "string" },
        { name: "time", type: "uint64" },
      ],
    },
    primaryType: "HyperliquidTransaction:SpotSend",
    message: { hyperliquidChain: net, destination: action.destination, token: p.token, amount: p.amount, time: BigInt(p.time) },
  });
  return { action, nonce: p.time, signature: splitSig(sig) };
}

/** keccak(msgpack(action) ‖ nonce (8 bytes BE) ‖ 0x00 for "no vault"). */
export function l1ActionHash(action: Record<string, unknown>, nonce: number): Hex {
  const packed = encode(action);
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  return keccak256(concat([packed, n, new Uint8Array([0])]));
}

export async function signL1Action(account: LocalAccount, net: Network, action: Record<string, unknown>, nonce: number) {
  const connectionId = l1ActionHash(action, nonce);
  const sig = await account.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: net === "Mainnet" ? "a" : "b", connectionId },
  });
  return { action, nonce, signature: splitSig(sig) };
}

export async function post(net: Network, path: "info" | "exchange", body: unknown): Promise<any> {
  const res = await fetch(`${API[net]}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: "error", response: text };
  }
}

export { toBytes };

/** Hyperliquid price rule: at most 5 significant figures and at most (8 - szDecimals) decimals for spot. */
export function hlPrice(px: number, szDecimals: number): string {
  const sig = Number(px.toPrecision(5));
  return sig.toFixed(Math.max(0, 8 - szDecimals)).replace(/\.?0+$/, "");
}
