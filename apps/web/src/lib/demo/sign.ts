/**
 * The plain-text message a wallet signs for a demo "transaction" (IA v3.1 item 13): what the action is, in the app's
 * words, and that nothing is sent. Signing it proves the wallet is there; it is never sent to a contract.
 */
import { Side } from "@confluere/sdk";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { chainMeta } from "../chains";
import { fmtToken } from "../format";
import type { Write } from "../tx";

const amount = (v: unknown, t: Write["token"]) => (typeof v === "bigint" && t ? fmtToken(v, t) : undefined);

/** One line on what the step does, when the write carries enough to say it. */
export function describeWrite(w: Write, chainId: number): string | undefined {
  const args = (w.args ?? []) as unknown[];
  const coin = chainMeta(chainId).native;
  switch (w.functionName) {
    case "approve":
      return "Allow Confluere to use this token for the next step.";
    case "deposit":
      return w.value !== undefined && args.length === 0 ? `Turn ${fmtToken(w.value, { decimals: 18, symbol: coin })} into W${coin}.` : undefined;
    case "placeOrder": {
      const p = args[1] as { side: number; units: bigint; budget: bigint } | undefined;
      if (!p) return undefined;
      if (p.side === Side.Sell || p.side === Side.NcSell) return amount(p.units, w.token) && `Borrow against ${amount(p.units, w.token)}.`;
      if (p.side === Side.NcBuy) return amount(p.budget, w.token) && `Lend ${amount(p.budget, w.token)} at the next round's price.`;
      return "Lend at your price.";
    }
    case "repay":
      return "Pay the buy-back price and get your collateral back.";
    case "rollover":
      return "Move this loan to a later date.";
    case "claim":
    case "claimMany":
      return "Collect what your matured lending paid out.";
    case "withdraw":
      return "Move a balance waiting in Confluere to your wallet.";
    case "cancelOrder":
      return "Cancel an order that has not filled.";
    case "requestDeposit":
      return amount(args[0], w.token) && `Deposit ${amount(args[0], w.token)} into the vault.`;
    case "requestRedeem":
      return "Ask the vault to pay out your shares at its next roll.";
    case "createPoolWithOptions":
      return "Open a new market with these terms.";
    case "buy":
      return "Become this market's LP.";
    case "demoSellC":
      return amount(args[1], w.token) ? `Sell C (lender token) backed by ${amount(args[1], w.token)} at the market price.` : "Sell C (lender token) at the market price.";
    case "demoSellR":
      return amount(args[1], w.token) ? `Sell R (buy-back right) on ${amount(args[1], w.token)} at the market price.` : "Sell R (buy-back right) at the market price.";
    case "demoBuyC":
      return amount(args[1], w.token) ? `Buy C (lender token) backed by ${amount(args[1], w.token)} at the market price.` : "Buy C (lender token) at the market price.";
    case "demoBuyR":
      return amount(args[1], w.token) ? `Buy R (buy-back right) on ${amount(args[1], w.token)} at the market price.` : "Buy R (buy-back right) at the market price.";
    default:
      return undefined;
  }
}

export function demoMessage(w: Write, o: { chainId: number; account: Address; at?: Date }): string {
  const line = describeWrite(w, o.chainId);
  return [
    `Confluere demo: ${w.label}`,
    ...(line ? [line] : []),
    "",
    "This is the demo on sample data. Signing sends no transaction and moves no funds.",
    `Network: ${chainMeta(o.chainId).label} (demo)`,
    `Account: ${o.account}`,
    `Time: ${(o.at ?? new Date()).toISOString()}`,
  ].join("\n");
}

/** A transaction-shaped id for the step list and toasts (derived from the signature, so it is unique per action). */
export const demoHash = (signature: string, label: string): Hex => keccak256(toHex(`${signature}:${label}:${Date.now()}`));
