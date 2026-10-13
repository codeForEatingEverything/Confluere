"use client";

import { Check, LoaderCircle } from "lucide-react";
import type { TxError, TxStep } from "@/lib/tx";
import { ErrorLine } from "./Surface";

/** "1 Approve WHYPE  2 Borrow" under a primary button when an action takes two signatures. */
export function StepsLine({ steps, labels }: { steps: TxStep[]; labels?: string[] }) {
  const list = steps.length > 0 ? steps : (labels ?? []).map((label) => ({ label, status: "idle" as const }));
  if (list.length < 2) return null;
  return (
    <ol className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-caption text-ink-3" aria-label="Steps" data-testid="steps-line">
      {list.map((s, i) => (
        <li key={`${s.label}-${i}`} className={`inline-flex items-center gap-1.5 ${s.status === "wallet" || s.status === "pending" ? "text-ink" : ""}`}>
          {s.status === "success" ? (
            <Check size={14} strokeWidth={1.75} className="text-good" aria-hidden />
          ) : s.status === "wallet" || s.status === "pending" ? (
            <LoaderCircle size={14} strokeWidth={2} className="spin" aria-hidden />
          ) : (
            <span className="num">{i + 1}</span>
          )}
          {s.label}
        </li>
      ))}
    </ol>
  );
}

/** The plain-language reason a step could not go ahead, shown above the button (never for a wallet rejection). */
export function TxErrorLine({ error, onRetry }: { error?: TxError; onRetry?: () => void }) {
  if (!error || error.kind === "rejected") return null;
  return (
    <ErrorLine
      action={
        onRetry ? (
          <button type="button" className="font-medium underline underline-offset-2" onClick={onRetry}>
            Try again
          </button>
        ) : undefined
      }
    >
      {error.title}
    </ErrorLine>
  );
}

/** The primary button's label while a transaction runs: the wallet step, then the chain step (Uniswap / Aave). */
export function stageLabel(steps: TxStep[], idle: string): string {
  const cur = steps.find((s) => s.status === "wallet" || s.status === "pending");
  if (!cur) return idle;
  return cur.status === "wallet" ? "Confirm in your wallet…" : "Submitting…";
}
