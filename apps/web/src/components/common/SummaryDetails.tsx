"use client";

/**
 * One summary row with a chevron; the full list opens below it (the home card's details, IA v3.1 item 1). The list
 * stays in the page while closed (`hidden`), so nothing is dropped, only folded.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function SummaryDetails({ summary, aside, children, testId, defaultOpen = false }: { summary: ReactNode; aside?: ReactNode; children: ReactNode; testId?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={testId ? `${testId}-summary` : undefined}
        className="-mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 text-left text-body-sm transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
      >
        <span className="num min-w-0 flex-1 text-ink">{summary}</span>
        {aside && <span className="num flex-none text-ink-2">{aside}</span>}
        <ChevronDown size={16} strokeWidth={1.75} className={`flex-none text-ink-3 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <div hidden={!open} className="mt-2">
        {children}
      </div>
    </div>
  );
}
