"use client";

import { ArrowUpRight, Info } from "lucide-react";
import { useConnection } from "wagmi";
import type { Token } from "@/lib/data";
import { fmtToken } from "@/lib/format";
import { mintWrite, useTokenNeed } from "@/lib/tokens";
import { useTx } from "@/lib/tx";
import { Button } from "../ui/Button";


/**
 * Shown under an amount well only when the selected market needs a token the wallet lacks (FRONTEND_V3 §8.1.6), with
 * the smallest step that fixes it: Circle's faucet for test USDC, or, for WHYPE / WMON, switching the card to pay with the
 * native coin (`onUseNative`; the wrap then runs inside the card's own button flow). Nothing else, never staking.
 */
export function TokenShortfall({ token, need, onUseNative }: { token: Token | undefined; need: bigint; onUseNative?: () => void }) {
  const { address } = useConnection();
  const q = useTokenNeed(token, need > 0n ? need : undefined).data;
  const tx = useTx();
  if (!token || !address || !q?.step || q.missing === 0n) return null;
  const s = q.step;
  const box = "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-caption text-ink-2";
  if (s.kind === "faucet")
    return (
      <div className={box} data-testid="token-shortfall">
        <Info size={14} strokeWidth={1.75} className="text-ink-3" aria-hidden />
        <span className="flex-1">Test {token.symbol} is available from Circle&apos;s faucet.</span>
        <a href={s.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline underline-offset-2">
          Open faucet <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
        </a>
      </div>
    );
  if (s.kind === "wrap") {
    // no separate wrap step (IA v3.1 item 11): the native coin is a pay-with choice of the same card
    if (!onUseNative || q.nativeBalance < q.missing) return null;
    return (
      <div className={box} data-testid="token-shortfall">
        <Info size={14} strokeWidth={1.75} className="text-ink-3" aria-hidden />
        <span className="num flex-1">You have {fmtToken(q.nativeBalance, { decimals: token.decimals, symbol: s.native })}. Pay with {s.native} instead.</span>
        <Button size="sm" variant="secondary" onClick={onUseNative} data-testid="use-native">
          Pay with {s.native}
        </Button>
      </div>
    );
  }
  return (
    <div className={box} data-testid="token-shortfall">
      <Info size={14} strokeWidth={1.75} className="text-ink-3" aria-hidden />
      <span className="flex-1">You need {fmtToken(q.missing, token)} more.</span>
      <Button size="sm" variant="secondary" loading={tx.busy} onClick={() => void tx.run([mintWrite(s.token, address, q.missing * 10n, token.symbol)])}>
        {s.label}
      </Button>
    </div>
  );
}
