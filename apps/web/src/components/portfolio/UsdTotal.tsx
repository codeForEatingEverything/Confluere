"use client";

/**
 * Dollar value of a list of token amounts at the display-only reference prices (lib/refPrice): USDC at 1, the
 * network's coin (HYPE / MON) at its USDC price, the staked coin through the coin. Nothing on-chain reads it; when a
 * price is missing the caller's fallback is shown instead of a partial sum.
 */
import { formatUnits, type Address } from "viem";
import { useActiveChainId } from "@/lib/activeChain";
import { launchTokensOf } from "@/lib/chains";
import { useRefPrice } from "@/lib/refPrice";
import type { Token } from "@/lib/data";

export type Amount = { token: string; amount: bigint; meta?: Token };

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function useUsdTotal(items: Amount[]): number | undefined {
  const chainId = useActiveChainId();
  const lt = launchTokensOf(chainId);
  const nativeUsd = useRefPrice(lt.native as Address | undefined, lt.usdc as Address | undefined).data;
  const lstNative = useRefPrice(lt.lst as Address | undefined, lt.native as Address | undefined).data;
  let total = 0;
  for (const it of items) {
    const t = it.token.toLowerCase();
    const dec = it.meta?.decimals;
    if (dec === undefined) return undefined;
    const n = Number(formatUnits(it.amount, dec));
    let px: number | null | undefined;
    if (lt.usdc && t === lt.usdc.toLowerCase()) px = 1;
    else if (lt.native && t === lt.native.toLowerCase()) px = nativeUsd;
    else if (lt.lst && t === lt.lst.toLowerCase()) px = lstNative && nativeUsd ? lstNative * nativeUsd : undefined;
    if (px === undefined || px === null) return undefined;
    total += n * px;
  }
  return total;
}

export const fmtUsdTotal = (v: number) => (v > 0 && v < 0.01 ? "< $0.01" : usd.format(v));

/** "≈ $172.40", or `fallback` while a price is unknown. */
export function UsdTotal({ items, fallback }: { items: Amount[]; fallback: React.ReactNode }) {
  const v = useUsdTotal(items);
  return <>{v === undefined ? fallback : `≈ ${fmtUsdTotal(v)}`}</>;
}
