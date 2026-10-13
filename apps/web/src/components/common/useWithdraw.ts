"use client";

import { type Address } from "viem";
import { withdrawWrite } from "@/lib/actions";
import { unwrapWrite } from "@/lib/tokens";
import { useActionCtx } from "@/lib/useProduct";
import { fmtAmount } from "@/lib/format";
import { useTx } from "@/lib/tx";
import type { Token } from "@/lib/data";

/**
 * Withdraw balances waiting in Confluere to the wallet, one token per transaction ("1 of 2" on the button). `unwrap`
 * (the coin's symbol) on a WHYPE / WMON item adds the unwrap right after, for a person who chose to receive HYPE / MON.
 */
export function useWithdraw() {
  const tx = useTx();
  const ctx = useActionCtx(tx);
  const run = (items: { token: Address; amount: bigint; meta?: Token; unwrap?: string }[]) => {
    if (!ctx || items.length === 0) return Promise.resolve({ ok: false });
    const text = items.map((i) => fmtAmount(i.amount, i.meta?.decimals ?? 18, i.unwrap ?? i.meta?.symbol)).join(" and ");
    return tx.run(
      items.flatMap((i) => (i.unwrap ? [withdrawWrite(ctx, i.token, i.meta?.symbol), unwrapWrite(i.token, i.amount, i.unwrap)] : [withdrawWrite(ctx, i.token, i.meta?.symbol)])),
      { successMessage: `Withdrawn ${text} to your wallet.` },
    );
  };
  return { tx, run, ready: !!ctx };
}
