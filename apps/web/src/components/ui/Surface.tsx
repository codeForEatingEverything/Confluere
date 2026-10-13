"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { ChevronDown, Check, CircleX, Clock, TriangleAlert } from "lucide-react";

/** Raised surface: radius 20, two shadows, no border. Never nest a Card in a Card; use Well inside. */
export function Card({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function Well({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`well ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function Skeleton({ className = "", label }: { className?: string; label?: string }) {
  return <div className={`skeleton ${className}`} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export type Tone = "brand" | "good" | "warn" | "bad" | "neutral";

const TONE: Record<Tone, string> = {
  brand: "bg-brand-soft text-brand-ink",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  neutral: "bg-surface-2 text-ink-2",
};

/** Small tag (13 px, pill). */
export function Pill({ tone = "neutral", children, title, className = "" }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-caption font-medium whitespace-nowrap ${TONE[tone]} ${className}`}>
      {children}
    </span>
  );
}

/** 16 px progress ring: the share of the running round already elapsed. Updated each second, not animated. */
export function Ring({ progress, size = 16 }: { progress: number; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, Math.max(0, progress));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90 flex-none">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.22} strokeWidth={2} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray={c} strokeDashoffset={c * (1 - p)} strokeLinecap="round" />
    </svg>
  );
}

const STATUS_ICON: Record<Tone, ReactNode> = {
  brand: <Clock size={16} strokeWidth={1.75} aria-hidden />,
  good: <Check size={16} strokeWidth={1.75} aria-hidden />,
  warn: <TriangleAlert size={16} strokeWidth={1.75} aria-hidden />,
  bad: <CircleX size={16} strokeWidth={1.75} aria-hidden />,
  neutral: <Clock size={16} strokeWidth={1.75} aria-hidden />,
};

/** The status pill: "Fills in about 1 min 40 s" with a ring, or a short state word with an icon. */
/**
 * The brand tone is a quiet inline line (ring + text, no fill) so it never outweighs the primary button; good / warn /
 * bad / neutral keep the filled bar. Not a live region unless `live` (a ticking countdown must not be announced).
 */
export function StatusPill({ tone = "brand", progress, children, action, className = "", live, ...rest }: { tone?: Tone; progress?: number; children: ReactNode; action?: ReactNode; className?: string; live?: boolean } & HTMLAttributes<HTMLDivElement>) {
  const quiet = tone === "brand";
  return (
    <div
      role={live ? "status" : undefined}
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${quiet ? "min-h-6 text-caption text-ink-2 [&_svg]:text-brand" : `min-h-10 rounded-[var(--radius-control)] px-3 py-2 text-body-sm ${TONE[tone]}`} ${className}`}
      {...rest}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {progress !== undefined ? <Ring progress={progress} /> : STATUS_ICON[tone]}
        <span className="min-w-0">{children}</span>
      </span>
      {action}
    </div>
  );
}

/**
 * The signature shape: two filled tiles side by side, what happens if the loan is repaid and what happens if it is not.
 * It says what makes Confluere different from collateralised lending: not repaying is a sale, not a liquidation.
 */
export function OutcomeStrip({ left, right }: { left: { title: string; body: ReactNode }; right: { title: string; body: ReactNode } }) {
  return (
    <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2" data-testid="outcome-strip">
      {[left, right].map((x) => (
        <div key={x.title} className="well px-4 py-3">
          <p className="text-caption font-medium text-ink-2">{x.title}</p>
          <p className="mt-1 text-body-sm leading-5 text-ink">{x.body}</p>
        </div>
      ))}
    </div>
  );
}

/** Collapsible section ("Advanced", "Details"), closed by default. */
export function Disclosure({ title, icon, children, open, onToggle, className = "" }: { title: string; icon?: ReactNode; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; className?: string }) {
  return (
    <details className={`group ${className}`} open={open} onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[var(--radius-control)] text-body-sm font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        {icon}
        <span className="flex-1">{title}</span>
        <ChevronDown size={16} strokeWidth={1.75} className="transition-transform duration-200 group-open:rotate-180" aria-hidden />
      </summary>
      <div className="pb-1 pt-2">{children}</div>
    </details>
  );
}

/** Empty state: left aligned, a sentence that says what is true, then the way out. */
export function EmptyState({ title, body, actions, className = "" }: { title: string; body?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`py-6 ${className}`} data-testid="empty-state">
      <p className="text-body font-medium text-ink">{title}</p>
      {body && <div className="mt-1 max-w-[60ch] text-body-sm leading-5 text-ink-2">{body}</div>}
      {actions && <div className="mt-4 flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}

/** One line in the error colour above a button (simulation reverts, invalid input). */
export function ErrorLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <p role="alert" className="flex flex-wrap items-baseline gap-x-2 text-body-sm leading-5 text-bad">
      <span>{children}</span>
      {action}
    </p>
  );
}

/** Section title inside a page (20 px), 16 px above its content. */
export function SectionTitle({ children, aside, id }: { children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3" id={id}>
      <h2 className="text-title font-medium">{children}</h2>
      {aside}
    </div>
  );
}

export type DetailRow = { k: ReactNode; v: ReactNode; hint?: ReactNode; tone?: "warn" | "good"; testId?: string };

/** Label-left / value-right rows (Uniswap swap details, Morpho position panel): each number once, tabular, 14 px. */
export function DetailRows({ rows, className = "" }: { rows: (DetailRow | false | null | undefined)[]; className?: string }) {
  return (
    <dl className={`space-y-1.5 text-body-sm ${className}`}>
      {rows.filter((r): r is DetailRow => !!r).map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-4" data-testid={r.testId}>
          <dt className="text-ink-2">{r.k}</dt>
          <dd className={`num text-right font-medium ${r.tone === "warn" ? "text-warn" : r.tone === "good" ? "text-good" : "text-ink"}`}>
            {r.v}
            {r.hint && <span className="block whitespace-normal text-caption font-normal text-ink-3">{r.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Stat tile: 13 px label, 20 px value, optional 13 px note. One size everywhere (drawers, Seats, Portfolio). */
export function Stat({ label, value, note, className = "" }: { label: ReactNode; value: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={`well px-4 py-3 ${className}`}>
      <p className="text-caption text-ink-2">{label}</p>
      <p className="num mt-0.5 text-title font-medium text-ink">{value}</p>
      {note && <p className="mt-0.5 text-caption text-ink-3">{note}</p>}
    </div>
  );
}
