"use client";

/**
 * The home card's two selectors (IA v3.1 item 1): Maturity and Pool. The router fills both; either opens a short list
 * in a modal (a bottom sheet on phones) so the person can choose for themselves, and the card's numbers follow at once.
 * The router's choice carries a "Best" tag so it is clear what changing it gives up.
 */
import { useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Modal } from "../ui";

export type SelectOption<T extends string | number> = { value: T; label: ReactNode; sub?: ReactNode; aside?: ReactNode; best?: boolean; testId?: string };

export function SelectField<T extends string | number>({
  label,
  title,
  value,
  options,
  onChange,
  testId,
  display,
}: {
  label: string;
  /** Modal title. */
  title: string;
  value: T | undefined;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  testId?: string;
  /** What the closed field shows (defaults to the selected option's label). */
  display?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  const many = options.length > 1;
  return (
    <>
      <button
        type="button"
        onClick={() => many && setOpen(true)}
        aria-haspopup={many ? "dialog" : undefined}
        aria-label={`${label}: ${typeof (display ?? cur?.label) === "string" ? (display ?? cur?.label) : "selected"}${many ? ", change" : ""}`}
        disabled={!many}
        data-testid={testId}
        className="well group flex min-h-[60px] w-full min-w-0 items-center gap-2 px-3.5 py-2 text-left transition-shadow enabled:hover:shadow-[inset_0_0_0_1px_var(--line-strong,var(--line))] focus-visible:outline-2 focus-visible:outline-[var(--focus)] disabled:cursor-default"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-caption text-ink-3">{label}</span>
          <span className="num block text-body-sm font-medium leading-5 text-ink">{display ?? cur?.label ?? "—"}</span>
        </span>
        {many && <ChevronDown size={16} strokeWidth={1.75} className="flex-none text-ink-3 transition-transform group-hover:translate-y-px" aria-hidden />}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} testId={testId ? `${testId}-list` : undefined}>
        <ul className="-mx-2" aria-label={title}>
          {options.map((o) => {
            const on = o.value === value;
            return (
              <li key={String(o.value)}>
                <button
                  type="button"
                  aria-current={on || undefined}
                  data-testid={o.testId}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-left hover:bg-surface-2 ${on ? "bg-surface-2" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="num flex items-center gap-2 text-body font-medium">
                      {o.label}
                      {o.best && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-label font-medium text-brand-ink">Best</span>}
                    </span>
                    {o.sub && <span className="num block text-caption text-ink-3">{o.sub}</span>}
                  </span>
                  {o.aside && <span className="num text-right text-body-sm text-ink-2">{o.aside}</span>}
                  {on && <Check size={16} strokeWidth={2} className="flex-none text-brand" aria-label="Selected" />}
                </button>
              </li>
            );
          })}
        </ul>
      </Modal>
    </>
  );
}
