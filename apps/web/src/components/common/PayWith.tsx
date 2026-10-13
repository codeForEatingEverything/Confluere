"use client";

/**
 * "Pay with" for one market token (IA v3.1 item 11). When the token is WHYPE / WMON the token button opens a small list
 * with the network's own coin (HYPE / MON, wallet balance) next to the wrapped token; picking the coin makes the card pay
 * in it, and the card's builder puts the wrap in front of its writes (`payNative`). For any other token the button is
 * plain. No separate wrap feature, no toggle: it is the same token selector a DEX has.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConnection } from "wagmi";
import { onchainSymbol, type Token } from "@/lib/data";
import { useActiveChainId } from "@/lib/activeChain";
import { useBalances } from "@/lib/position";
import { isWrappedNative, nativeTokenOf, spendableNative, useNativeBalance } from "@/lib/native";
import { tokenName } from "@/lib/logos";
import { parsePay } from "@/lib/twins";
import { fmtToken } from "@/lib/format";
import { TokenButton, TokenSelect } from "../ui";

export type PayWith = ReturnType<typeof usePayWith>;

/**
 * `preferNative`: start on the coin when it can pay (a DEX starts on ETH, not WETH). A list row's pairing overrides it
 * (lib/twins): `?pay=native` (the HYPE / MON row) starts on the coin, `?pay=wrapped` (the WHYPE / WMON row) on the
 * wrapped token. "Receive as" selectors (`receive`) ignore the preset: nothing is ever unwrapped unless picked.
 */
export function usePayWith(token: Token | undefined, { preferNative = true, title = "Pay with", receive = title === "Receive as" }: { preferNative?: boolean; title?: string; receive?: boolean } = {}) {
  const chainId = useActiveChainId();
  const { address } = useConnection();
  const can = !!token && isWrappedNative(chainId, token.address);
  const preset = receive ? undefined : parsePay(useSearchParams()?.get("pay"));
  const [pickNative, setPickNative] = useState(preset ? preset === "native" : preferNative);
  // a row opened later (same drawer, the other pairing) moves the choice with it
  useEffect(() => {
    if (preset) setPickNative(preset === "native");
  }, [preset]);
  const [open, setOpen] = useState(false);
  const native = can && pickNative;
  const nat = nativeTokenOf(chainId);
  const tokenBal = useBalances(token ? [token.address] : []).data?.[token?.address.toLowerCase() ?? ""];
  const nativeBal = useNativeBalance(chainId);
  const bal = native ? nativeBal : tokenBal;
  /** The most the card may spend: the native coin keeps a little back for gas. */
  const max = native && bal !== undefined ? spendableNative(bal, chainId) : bal;
  /** The wrapped coin under its own name (WHYPE / WMON), a separate entry from the coin. */
  const wrappedSym = onchainSymbol(token) ?? `W${nat.symbol}`;
  const P: Token | undefined = native ? nat : token;
  const button = <TokenButton symbol={P?.symbol} address={P?.address} onClick={can ? () => setOpen(true) : undefined} label={can ? `${title}, ${P?.symbol} selected` : undefined} />;
  const picker =
    can && token ? (
      <TokenSelect
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        value={native ? nat.address : token.address}
        tokens={[
          { address: nat.address, symbol: nat.symbol, name: tokenName(nat.symbol), balance: address && nativeBal !== undefined ? fmtToken(nativeBal, nat, false) : undefined },
          { address: token.address, symbol: wrappedSym, name: tokenName(wrappedSym) ?? `Wrapped ${nat.symbol}`, wrapped: true, balance: address && tokenBal !== undefined ? fmtToken(tokenBal, token, false) : undefined },
        ]}
        onPick={(a) => setPickNative(a.toLowerCase() === nat.address.toLowerCase())}
      />
    ) : null;
  return { can, native, P, bal, max, nat, button, picker, setNative: setPickNative, nativeSymbol: native ? nat.symbol : undefined };
}
