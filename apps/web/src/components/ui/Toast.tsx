"use client";

/**
 * Toasts (FRONTEND_V3 §7.5, §8.8): only for failures and for successes whose effect is not visible on screen
 * (a withdrawal). A wallet rejection is neutral grey. A simulation revert is shown above the button that caused it,
 * so it never becomes a toast. Successes from lib/tx without a caller message ("…: done") stay silent: the card or
 * row that changed carries them.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleX, X } from "lucide-react";
import { chainMeta, explorerTxUrl } from "@/lib/chains";
import { dismissToast, useToasts, type Toast } from "@/lib/txStore";

export function toastVisible(t: Toast): boolean {
  // a wallet rejection is the user's own choice: the button resets, nothing else to say
  if (t.status === "rejected") return false;
  if (t.status === "failed" && !t.hash && (t.error?.kind === "reverted" || t.error?.kind === "funds")) return false;
  return true;
}

function Item({ t }: { t: Toast }) {
  const [hover, setHover] = useState(false);
  const sticky = t.status === "failed";
  // links need time to reach by keyboard: 10 s when the toast carries one
  const left = useRef(t.hash ? 10_000 : 5000);
  useEffect(() => {
    if (sticky || hover) return;
    const started = Date.now();
    const id = setTimeout(() => dismissToast(t.id), left.current);
    return () => {
      clearTimeout(id);
      left.current -= Date.now() - started;
    };
  }, [hover, sticky, t.id]);
  const url = t.hash && t.chainId ? explorerTxUrl(t.chainId, t.hash) : undefined;
  const failed = t.status === "failed";
  const title = failed ? `Transaction failed on ${chainMeta(t.chainId ?? 0).label}.` : t.title;
  return (
    <li
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className="card flex w-full items-start gap-3 px-4 py-3 text-body-sm shadow-overlay"
      data-testid="toast"
    >
      <span className={`mt-0.5 ${failed ? "text-bad" : t.status === "success" ? "text-good" : "text-ink-3"}`} aria-hidden>
        {failed ? <CircleX size={16} strokeWidth={1.75} /> : t.status === "success" ? <Check size={16} strokeWidth={1.75} /> : <X size={16} strokeWidth={1.75} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ink">{title}</p>
        {failed && t.error?.title && <p className="mt-0.5 text-caption text-ink-2">{t.error.title}</p>}
        {(url || (failed && t.retry)) && (
          <p className="mt-1.5 flex gap-4 text-caption">
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1">
                View <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
              </a>
            )}
            {failed && t.retry && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  dismissToast(t.id);
                  t.retry?.();
                }}
              >
                Try again
              </button>
            )}
          </p>
        )}
      </div>
      <button type="button" aria-label="Dismiss" className="-mr-1 rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => dismissToast(t.id)}>
        <X size={16} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

export function ToastRegion() {
  const list = useToasts().filter(toastVisible);
  return (
    <ol aria-live="polite" className="pointer-events-none fixed bottom-[calc(80px+env(safe-area-inset-bottom))] right-4 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 lg:bottom-6 lg:right-6 [&>li]:pointer-events-auto" style={{ zIndex: "var(--z-toast)" }}>
      {list.map((t) => (
        <Item key={t.id} t={t} />
      ))}
    </ol>
  );
}
