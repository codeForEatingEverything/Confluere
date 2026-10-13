"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useNow } from "@/lib/data";
import { explorerAddressUrl } from "@/lib/chains";
import { useActiveChain } from "@/lib/activeChain";
import { fmtExpiry, fmtWait, short } from "@/lib/format";

/** Chain time that ticks every second between block reads (block timestamp + local elapsed time). 0 until known. */
export function useLiveNow(): number {
  const q = useNow().data;
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!q) return 0;
  return Math.floor(q.ts + (Date.now() / 1000 - q.wall));
}

/** "Tue 13 Oct, 09:00 UTC"; with `approx` the time is an estimate from block counts: "Tue 13 Oct, ≈ 11:00 UTC". */
export function DateTime({ ts, approx }: { ts: number; approx?: boolean }) {
  const s = fmtExpiry(ts);
  const text = approx ? s.replace(/, (\d)/, ", ≈ $1") : s;
  return (
    <time dateTime={new Date(ts * 1000).toISOString()} className="num whitespace-normal">
      {text}
    </time>
  );
}

/** Live "1 min 40 s" until `to` (chain time). */
export function Countdown({ to, now }: { to: number; now: number }) {
  return <span className="num">{fmtWait(Math.max(0, to - now))}</span>;
}

/** Address in mono with copy and an explorer link. */
export function Address({ address, full }: { address: string; full?: boolean }) {
  const { chainId } = useActiveChain();
  const [copied, setCopied] = useState(false);
  const url = explorerAddressUrl(chainId, address);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span className="mono text-ink" title={address}>
        {full ? address : short(address)}
      </span>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy address"}
        className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} strokeWidth={1.75} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
      </button>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" aria-label="View on explorer" className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink">
          <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden />
        </a>
      )}
    </span>
  );
}

/** Tooltip: 800 ms on hover, immediately on keyboard focus. */
export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  return (
    <span className="relative inline-flex" onMouseEnter={() => show(800)} onMouseLeave={hide} onFocus={() => show(0)} onBlur={hide}>
      <span aria-describedby={open ? id : undefined} tabIndex={0} className="inline-flex rounded-full">
        {children}
      </span>
      {open && (
        <span id={id} role="tooltip" className="card absolute bottom-[calc(100%+6px)] left-0 z-[var(--z-dropdown)] w-max max-w-[260px] px-3 py-2 text-caption leading-[18px] text-ink shadow-overlay">
          {text}
        </span>
      )}
    </span>
  );
}
