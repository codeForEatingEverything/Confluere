"use client";

import type { KeyboardEvent, ReactNode } from "react";

export type Option<T> = { value: T; label: ReactNode; disabled?: boolean; testId?: string };

/** Two to four mutually exclusive options in a pill track (arrow keys move the choice). */
export function Segmented<T extends string | number>({ label, value, onChange, options, className = "" }: { label: string; value: T; onChange: (v: T) => void; options: Option<T>[]; className?: string }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
    const next = e.key === "Home" ? enabled[0] : e.key === "End" ? enabled[enabled.length - 1] : enabled[(i + (fwd ? 1 : enabled.length - 1)) % enabled.length];
    if (next) {
      e.preventDefault();
      onChange(next.value);
      (e.currentTarget.querySelector(`[data-v="${String(next.value)}"]`) as HTMLButtonElement | null)?.focus();
    }
  };
  return (
    <div role="radiogroup" aria-label={label} className={`seg ${className}`} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          data-v={String(o.value)}
          data-testid={o.testId}
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className="whitespace-nowrap disabled:opacity-40"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ selected, onClick, children, testId, title }: { selected: boolean; onClick: () => void; children: ReactNode; testId?: string; title?: string }) {
  return (
    <button type="button" className="chip" aria-pressed={selected} onClick={onClick} data-testid={testId} title={title}>
      {children}
    </button>
  );
}

/**
 * Single choice as chips: a 13 px label above, chips wrapping onto a second line rather than being cut. A radio group
 * (arrow keys move the choice), same left edge as the wells.
 */
export function ChipRow<T extends string | number>({ label, value, onChange, options, hideLabel, helper }: { label: string; value: T | undefined; onChange: (v: T) => void; options: Option<T>[]; hideLabel?: boolean; helper?: ReactNode }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length];
    if (next) {
      e.preventDefault();
      onChange(next.value);
      (e.currentTarget.querySelector(`[data-v="${String(next.value)}"]`) as HTMLButtonElement | null)?.focus();
    }
  };
  return (
    <div className="min-w-0">
      {!hideLabel && <p className="mb-1.5 text-caption text-ink-2">{label}</p>}
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2" onKeyDown={onKey}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            className="chip"
            data-v={String(o.value)}
            aria-checked={o.value === value}
            tabIndex={o.value === value || (value === undefined && o === options[0]) ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            data-testid={o.testId}
          >
            {o.label}
          </button>
        ))}
      </div>
      {helper && <p className="mt-1.5 text-caption text-ink-3">{helper}</p>}
    </div>
  );
}
