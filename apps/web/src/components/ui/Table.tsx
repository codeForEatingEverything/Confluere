"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { Skeleton } from "./Surface";

export type Column<R> = {
  key: string;
  header: ReactNode;
  cell: (r: R) => ReactNode;
  /** Right-align (numbers, actions). */
  end?: boolean;
  /** Hide on phones (the row stacks its cells). */
  wide?: boolean;
  /** Label for the phone key/value layout (defaults to `header`); `false` renders the cell bare (actions). */
  label?: ReactNode | false;
};

/**
 * A list on one raised surface, header on desktop (13 px, ink-3) and stacked rows on phones, a line between rows,
 * the whole row clickable when `onRow` is given. Buttons inside a row stop the row click themselves.
 */
export function List<R>({
  columns,
  template,
  rows,
  rowKey,
  onRow,
  rowLabel,
  loading,
  empty,
  error,
  testId,
}: {
  columns: Column<R>[];
  /** CSS grid-template-columns for ≥ 1024 px. */
  template: string;
  rows: R[];
  rowKey: (r: R) => string;
  onRow?: (r: R) => void;
  rowLabel?: (r: R) => string;
  loading?: boolean;
  empty?: ReactNode;
  /** Reads failed and there is no data yet: skeleton rows plus this line, never the empty state. */
  error?: ReactNode;
  testId?: string;
}) {
  const style = { "--cols": template } as React.CSSProperties;
  if (loading || error)
    return (
      <div className="card p-2 lg:grid lg:gap-x-6 lg:[grid-template-columns:var(--cols)]" style={style} data-testid={testId ? `${testId}-loading` : undefined} aria-busy>
        {error && <div className="px-3 pb-1 pt-2 lg:col-span-full">{error}</div>}
        <div className="hidden px-3 pb-2 pt-2 text-caption text-ink-3 lg:col-span-full lg:grid lg:grid-cols-subgrid">
          {columns.map((c) => (
            <span key={c.key} className={c.end ? "text-right" : ""}>
              {c.header}
            </span>
          ))}
        </div>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="row flex items-center gap-4 px-3 py-4 lg:col-span-full lg:grid lg:grid-cols-subgrid">
            {columns.map((c, j) => (
              <Skeleton key={c.key} className={`h-4 ${j === 0 ? "w-40" : "w-16 max-lg:hidden"} ${c.end ? "lg:justify-self-end" : ""}`} />
            ))}
          </div>
        ))}
      </div>
    );
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div role="table" className="card p-2 text-body-sm lg:grid lg:gap-x-6 lg:overflow-x-auto lg:[grid-template-columns:var(--cols)]" data-testid={testId} style={style}>
      <div role="row" className="hidden px-3 pb-2 pt-2 text-caption text-ink-3 lg:col-span-full lg:grid lg:grid-cols-subgrid">
        {columns.map((c) => (
          <span role="columnheader" key={c.key} className={`whitespace-nowrap ${c.end ? "text-right" : ""}`}>
            {c.header}
          </span>
        ))}
      </div>
      {rows.map((r) => {
        const click = onRow ? () => onRow(r) : undefined;
        const key = (e: KeyboardEvent) => {
          if (click && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            click();
          }
        };
        return (
          <div
            role="row"
            key={rowKey(r)}
            tabIndex={click ? 0 : undefined}
            title={rowLabel?.(r)}
            onClick={click}
            onKeyDown={key}
            data-testid={testId ? `${testId}-row` : undefined}
            className={`row grid grid-cols-2 items-center gap-x-4 gap-y-2 rounded-[var(--radius-control)] px-3 py-3.5 lg:col-span-full lg:grid-cols-subgrid ${click ? "row-hover cursor-pointer" : ""}`}
          >
            {columns.map((c, i) => {
              const lab = c.label === false ? undefined : (c.label ?? c.header);
              return (
                <div role="cell" key={c.key} className={`min-w-0 ${i === 0 || c.label === false ? "col-span-2 lg:col-span-1" : ""} ${c.end ? "lg:justify-self-end lg:text-right" : ""} ${c.wide ? "max-lg:hidden" : ""}`}>
                  {i > 0 && lab && <span className="block text-label text-ink-3 lg:hidden">{lab}</span>}
                  <div className={c.end ? "whitespace-nowrap" : ""}>{c.cell(r)}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** "Can't reach {network}. Retrying…" with a Retry button, shown inside a list or section whose reads failed. */
export function ErrorRow({ network, onRetry }: { network: string; onRetry: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 text-caption text-warn" role="status">
      <span>Can&apos;t reach {network}. Retrying…</span>
      <button type="button" className="font-medium underline underline-offset-2" onClick={onRetry}>
        Retry now
      </button>
    </p>
  );
}

/** Stop a click inside a clickable row from opening the row. */
export const stop = (fn: () => void) => (e: React.MouseEvent) => {
  e.stopPropagation();
  fn();
};
