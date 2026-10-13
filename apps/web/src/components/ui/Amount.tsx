"use client";

/*
 * Hallmark · component: input (amount well) · genre: modern-minimal · theme: custom (petrol)
 * states: default · hover · focus · active · disabled · loading · error · success
 * The well never turns red: an error replaces the helper text in its top-right corner.
 */
import { useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { useActiveChainId } from "@/lib/activeChain";
import { tokenLogo } from "@/lib/logos";
import { chainMeta, launchTokensOf } from "@/lib/chains";
import { Modal } from "./Overlay";

/** Whether a token is the network's wrapped coin (WHYPE / WMON): by the deployment's address, else by symbol. */
function isWrappedCoin(chainId: number, address?: string, symbol?: string): boolean {
  const w = launchTokensOf(chainId).native;
  if (address && w) return address.toLowerCase() === w.toLowerCase();
  return !!symbol && symbol.toUpperCase() === `W${chainMeta(chainId).native}`;
}

/**
 * Token disc: the official logo (bundled under public/tokens/<chainId>/<address>, lib/logos.ts) with a 1 px inset ring
 * so light logos sit on light surfaces; a neutral initial disc only for tokens without a known logo. The wrapped coin
 * (WHYPE / WMON) uses the coin's logo with a small "W" mark, so HYPE and WHYPE read as two tokens of one coin.
 * `wrapped` overrides the detection. The mark sits top right (`markAt`), clear of the bottom badges of the position
 * (C / R) and LP icons; LpIcon moves the left disc's mark to the top left so the stacked disc never covers it.
 */
export function TokenIcon({ symbol, address, size = 20, wrapped, markAt = "tr" }: { symbol?: string; address?: string; size?: number; wrapped?: boolean; markAt?: "tr" | "tl" }) {
  const chainId = useActiveChainId();
  const src = tokenLogo(chainId, address, symbol);
  const s = (symbol ?? "?").toUpperCase();
  const disc = src ? (
    <span className="relative inline-block flex-none overflow-hidden rounded-full shadow-[inset_0_0_0_1px_var(--line)]" style={{ width: size, height: size }} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} width={size} height={size} alt="" className="h-full w-full object-cover" />
    </span>
  ) : (
    <span aria-hidden className="inline-flex flex-none items-center justify-center rounded-full bg-surface-2 font-semibold text-ink-2" style={{ width: size, height: size, fontSize: size * 0.45 }}>
      {s.slice(0, 1)}
    </span>
  );
  if (!(wrapped ?? isWrappedCoin(chainId, address, symbol))) return disc;
  const fs = Math.max(7, Math.round(size * 0.26));
  return (
    <span className="relative inline-flex flex-none" data-testid="wrapped-badge" aria-hidden>
      {disc}
      {/* the mark is drawn by CSS (content: attr) so it never joins the row's text */}
      <span data-mark="W" className={`absolute -top-0.5 ${markAt === "tl" ? "-left-1" : "-right-1"} rounded-full bg-surface px-[3px] font-semibold text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] after:content-[attr(data-mark)]`} style={{ fontSize: fs, lineHeight: `${Math.round(fs * 1.5)}px` }} />
    </span>
  );
}

/** Token pill inside a well: icon, symbol, and a chevron when it opens a list. */
export function TokenButton({ symbol, address, onClick, label }: { symbol?: string; address?: string; onClick?: () => void; label?: string }) {
  const body = (
    <>
      <TokenIcon symbol={symbol} address={address} size={24} />
      <span className="text-body font-medium">{symbol ?? "Select"}</span>
      {onClick && <ChevronDown size={16} strokeWidth={1.75} className="text-ink-2" aria-hidden />}
    </>
  );
  if (!onClick)
    return <span className="inline-flex h-10 flex-none items-center gap-2 rounded-full bg-surface px-3 shadow-whisper">{body}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? `Choose token, ${symbol ?? "none"} selected`}
      className="btn inline-flex h-10 flex-none items-center gap-2 rounded-full bg-surface px-3 shadow-whisper hover:bg-surface-2"
      data-testid="token-button"
    >
      {body}
    </button>
  );
}

/**
 * Keep only digits and one dot; at most `decimals` fraction digits. Commas are thousands separators when the text also
 * has a dot or ends in ",ddd" (pasted "1,000" / "1,000.5"); a lone comma otherwise is a decimal point ("0,5").
 */
export function cleanAmount(v: string, decimals: number): string {
  const thousands = (v.includes(",") && v.includes(".")) || /,\d{3}$/.test(v.trim());
  let t = (thousands ? v.replace(/,/g, "") : v.replace(/,/g, ".")).replace(/[^0-9.]/g, "");
  const i = t.indexOf(".");
  if (i >= 0) t = t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, "").slice(0, decimals);
  return t;
}

export function AmountInput({
  label,
  value,
  onChange,
  decimals = 18,
  token,
  readOnly,
  helper,
  balance,
  onMax,
  error,
  big = true,
  testId,
  placeholder = "0",
  autoFocus,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  decimals?: number;
  token?: ReactNode;
  readOnly?: boolean;
  helper?: ReactNode;
  balance?: ReactNode;
  onMax?: () => void;
  error?: string;
  big?: boolean;
  testId?: string;
  placeholder?: string;
  /** Focus this field when its drawer or modal opens (wide screens). */
  autoFocus?: boolean;
}) {
  const id = useId();
  const describedBy = [error && `${id}-err`, (helper || balance) && `${id}-help`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="well relative px-4 pb-3 pt-3 transition-shadow has-[input:focus:not([readonly])]:shadow-[inset_0_0_0_1px_var(--brand)]">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-caption font-medium text-ink-2">
          {label}
        </label>
        {error && (
          <span id={`${id}-err`} role="alert" className="text-right text-caption text-bad" data-testid="amount-error">
            {error}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-3">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          readOnly={readOnly}
          value={value}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy}
          data-autofocus={autoFocus || undefined}
          data-testid={testId}
          onChange={(e) => onChange?.(cleanAmount(e.target.value, decimals))}
          className={`num min-w-0 flex-1 bg-transparent font-medium text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none ${big ? "h-10 text-amount" : "h-8 text-title"} ${readOnly ? "cursor-default" : ""}`}
        />
        {token}
      </div>
      {(helper || balance || onMax || !readOnly) && (
        <div id={`${id}-help`} className="mt-1.5 flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-caption text-ink-3">
          <span className="min-w-0">{helper}</span>
          {(balance || onMax) && (
            <span className="ml-auto flex items-center gap-2">
              {balance}
              {onMax && (
                <button type="button" onClick={onMax} className="h-7 rounded-full bg-brand-soft px-2.5 text-label font-medium text-brand-ink hover:bg-surface">
                  Max
                </button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** `wrapped`: the wrapped form of the network's coin (WHYPE / WMON), shown with a small "W" mark on its icon. */
/** `conversion`: a 1:1 wrap (HYPE ↔ WHYPE), listed for completeness but not a market; shown, not pickable. */
export type TokenChoice = { address: string; symbol: string; name?: string; note?: ReactNode; balance?: ReactNode; wrapped?: boolean; conversion?: boolean };

/**
 * Token list in a modal (a bottom sheet on phones): the search field is focused on open, rows show logo, symbol, name
 * and wallet balance, the current token carries a check. ArrowUp/Down move between rows, Enter in search picks the first.
 */
export function TokenSelect({ open, onClose, title, tokens, value, onPick, allowAddress }: { open: boolean; onClose: () => void; title: string; tokens: TokenChoice[]; value?: string; onPick: (address: string) => void; allowAddress?: boolean }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? tokens.filter((x) => x.symbol.toLowerCase().includes(t) || x.name?.toLowerCase().includes(t) || x.address.toLowerCase().startsWith(t)) : tokens;
  }, [q, tokens]);
  const pick = (a: string) => {
    onPick(a);
    onClose();
  };
  const move = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(e.currentTarget.closest("[data-token-select]")?.querySelectorAll<HTMLElement>("[data-token-row]") ?? []);
    const i = rows.indexOf(document.activeElement as HTMLElement);
    rows[e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)]?.focus();
  };
  const custom = allowAddress && /^0x[0-9a-fA-F]{40}$/.test(q.trim()) && !tokens.some((t) => t.address.toLowerCase() === q.trim().toLowerCase());
  return (
    <Modal open={open} onClose={onClose} title={title} testId="token-select">
      <div data-token-select onKeyDown={move}>
        <label className="well flex h-12 items-center gap-2 px-3 has-[input:focus]:shadow-[inset_0_0_0_1px_var(--brand)]">
          <Search size={18} strokeWidth={1.75} className="text-ink-3" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && list[0]) pick(list[0].address);
              else if (e.key === "Enter" && custom) pick(q.trim());
            }}
            data-autofocus
            placeholder={allowAddress ? "Search name or paste address" : "Search name or address"}
            aria-label="Search tokens"
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-ink-3 focus-visible:outline-none"
          />
        </label>
        <p className="sr-only" aria-live="polite">
          {list.length === 0 ? "No token matches" : `${list.length} token${list.length > 1 ? "s" : ""}`}
        </p>
        <ul className="-mx-2 mt-3" aria-label={title}>
          {list.map((t) => {
            const on = value?.toLowerCase() === t.address.toLowerCase();
            return (
              <li key={t.address}>
                <button
                  type="button"
                  data-token-row
                  aria-current={on || undefined}
                  disabled={t.conversion}
                  data-testid={t.conversion ? "token-conversion" : undefined}
                  onClick={() => pick(t.address)}
                  className={`flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 text-left enabled:hover:bg-surface-2 disabled:cursor-default disabled:opacity-70 ${on ? "bg-surface-2" : ""}`}
                >
                  <TokenIcon symbol={t.symbol} address={t.address} size={36} wrapped={t.wrapped} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium">{t.symbol}</span>
                    <span className="block truncate text-caption text-ink-3">{t.name ?? t.note}</span>
                  </span>
                  <span className="text-right">
                    {t.balance !== undefined && <span className="num block text-body-sm text-ink">{t.balance}</span>}
                    {t.name && t.note && <span className="block text-caption text-ink-3">{t.note}</span>}
                  </span>
                  {on && <Check size={16} strokeWidth={2} className="flex-none text-brand" aria-label="Selected" />}
                </button>
              </li>
            );
          })}
          {custom && (
            <li>
              <button type="button" data-token-row onClick={() => pick(q.trim())} className="flex min-h-16 w-full items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 text-left hover:bg-surface-2">
                <TokenIcon size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium">Use this address</span>
                  <span className="mono block text-ink-3">{q.trim()}</span>
                </span>
              </button>
            </li>
          )}
          {list.length === 0 && !custom && <li className="px-2 py-6 text-center text-body-sm text-ink-2">No token found.{allowAddress ? " Paste a token address to use it." : ""}</li>}
        </ul>
      </div>
    </Modal>
  );
}
