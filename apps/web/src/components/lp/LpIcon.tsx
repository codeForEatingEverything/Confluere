"use client";

/**
 * LP token icon (IA v3.1 item 8): the pair's two token logos stacked, with a small "LP" badge. The same picture is
 * served as an SVG by /api/lp-icon for "Add to wallet".
 */
import { TokenIcon } from "../ui";

export function LpIcon({ asset, quote, size = 28 }: { asset?: { symbol?: string; address?: string }; quote?: { symbol?: string; address?: string }; size?: number }) {
  return (
    <span className="relative inline-flex flex-none items-center pb-1.5" aria-hidden data-testid="lp-icon">
      <span className="flex -space-x-2">
        <TokenIcon symbol={asset?.symbol} address={asset?.address} size={size} markAt="tl" />
        <TokenIcon symbol={quote?.symbol} address={quote?.address} size={size} />
      </span>
      <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 rounded-full bg-brand px-1.5 text-[10px] font-semibold leading-[15px] text-white ring-2 ring-surface">LP</span>
    </span>
  );
}
