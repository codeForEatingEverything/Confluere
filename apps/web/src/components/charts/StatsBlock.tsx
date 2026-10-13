"use client";

/**
 * "Stats" block under a market chart (IA v3.1 items 8 and 9; Uniswap token page): a small heading, then label / value
 * tiles in a grid, each value large and plain with its unit, and a one-line note where a number needs context.
 */
import type { ReactNode } from "react";

export type StatItem = { k: string; v: ReactNode; note?: ReactNode; mono?: boolean };

export function StatsBlock({ items, title = "Stats", testId = "stats" }: { items: StatItem[]; title?: string; testId?: string }) {
  return (
    <section className="card px-4 py-4 sm:px-5" aria-label={title} data-testid={testId}>
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {items.map((s) => (
          <div key={s.k} className="min-w-0" data-testid={`${testId}-item`}>
            <dt className="text-caption text-ink-2">{s.k}</dt>
            <dd className={`mt-0.5 text-title font-medium text-ink ${s.mono ? "mono" : "num"} break-words`}>{s.v}</dd>
            {s.note && <dd className="mt-0.5 text-caption text-ink-3">{s.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
