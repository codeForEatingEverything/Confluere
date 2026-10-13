"use client";

/**
 * Position token icon (C / R): the collateral's logo with a small two-letter badge at the bottom right, the way the
 * LP icon puts "LP" under a stacked pair (components/lp/LpIcon). The quote token stays out of the picture; it is in the
 * name. C's badge is petrol, R's a warm neutral (--accent-right). A matured or expired token is drawn at 60%; an
 * expired R also has its badge crossed out (the caller writes "Expired" next to it).
 */
import type { PositionKind } from "@/lib/vocab";
import { POSITION } from "@/lib/vocab";
import { TokenIcon } from "./Amount";

export function PositionIcon({ t, asset, size = 28, faded, expired }: { t: PositionKind; asset?: { symbol?: string; address?: string }; size?: number; faded?: boolean; expired?: boolean }) {
  const fs = Math.max(8, Math.round(size * 0.32));
  return (
    <span className={`relative inline-flex flex-none ${faded || expired ? "opacity-60" : ""}`} style={{ width: size, height: size }} aria-hidden data-testid={`position-icon-${t}`}>
      <TokenIcon symbol={asset?.symbol} address={asset?.address} size={size} />
      <span
        className={`absolute -bottom-1 -right-1.5 rounded-full px-[3px] font-semibold ring-[1.5px] ring-surface ${t === "ft" ? "bg-brand text-on-brand" : "bg-accent-right text-accent-right-ink"} ${expired ? "line-through" : ""}`}
        style={{ fontSize: fs, lineHeight: `${fs + 3}px` }}
      >
        {POSITION[t].prefix}
      </span>
    </span>
  );
}
