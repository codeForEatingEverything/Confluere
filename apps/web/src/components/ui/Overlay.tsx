"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";

const CLOSE_MS = 160;

/** Focus the panel's [data-autofocus] control (amount field, search box) on wide screens; the panel itself otherwise. */
function useInitialFocus(mounted: boolean, open: boolean) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mounted || !open) return;
    const t = setTimeout(() => {
      const p = panel.current;
      if (!p) return;
      const wide = typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches;
      const target = wide ? p.querySelector<HTMLElement>("[data-autofocus]") : null;
      (target ?? p).focus({ preventScroll: true });
    }, 30);
    return () => clearTimeout(t);
  }, [mounted, open]);
  return panel;
}

/** Open / close a native <dialog> with a short exit transition; Esc and a backdrop click call onClose. */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      d.removeAttribute("data-closing");
      if (!d.open) {
        if (typeof d.showModal === "function") {
          try {
            d.showModal();
          } catch {
            d.setAttribute("open", "");
          }
        } else d.setAttribute("open", "");
      }
      return;
    }
    if (!d.open && !d.hasAttribute("open")) return;
    d.setAttribute("data-closing", "");
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => {
      d.removeAttribute("data-closing");
      if (typeof d.close === "function" && d.open) d.close();
      else d.removeAttribute("open");
    }, reduce ? 150 : CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);
  const props = {
    ref,
    onCancel: (e: React.SyntheticEvent) => {
      e.preventDefault();
      onClose();
    },
    onClick: (e: React.MouseEvent<HTMLDialogElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
  };
  return props;
}

/**
 * Side panel for an action (≥ 1024 px: from the right, `width` px; smaller: a bottom sheet up to 92% of the screen with a
 * drag handle). Children render only while open so each opening starts fresh.
 */
export function Drawer({ open, onClose, title, subtitle, width = 440, children, footer, testId }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; width?: number; children: ReactNode; footer?: ReactNode; testId?: string }) {
  const d = useDialog(open, onClose);
  const id = useId();
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
    else {
      const t = setTimeout(() => setMounted(false), CLOSE_MS);
      return () => clearTimeout(t);
    }
  }, [open]);
  const panel = useInitialFocus(mounted, open);
  return (
    <dialog {...d} className="overlay" aria-labelledby={id} data-testid={testId} style={{ zIndex: "var(--z-drawer)" } as React.CSSProperties}>
      {mounted && (
        <div ref={panel} className="drawer-panel outline-none" tabIndex={-1} style={{ "--drawer-w": `${width}px`, transform: drag ? `translateY(${drag}px)` : undefined } as React.CSSProperties}>
          <div
            className="flex justify-center pt-2 lg:hidden"
            onPointerDown={(e) => {
              start.current = e.clientY;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => start.current !== null && setDrag(Math.max(0, e.clientY - start.current))}
            onPointerUp={() => {
              if (drag > 80) onClose();
              start.current = null;
              setDrag(0);
            }}
            aria-hidden
          >
            <span className="h-1 w-9 rounded-full bg-line-strong" />
          </div>
          <header className="flex items-start gap-3 px-6 pb-2 pt-4 max-lg:px-4 lg:pt-6">
            <div className="min-w-0 flex-1">
              <h2 id={id} className="text-title font-semibold leading-[26px]">
                {title}
              </h2>
              {subtitle && <p className="mt-1 text-body-sm leading-5 text-ink-2">{subtitle}</p>}
            </div>
            <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
              <X size={20} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2 max-lg:px-4">{children}</div>
          {footer && <div className="drawer-footer px-6 pt-3 max-lg:px-4">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** Centred dialog for one step (Review, Repay, Claim, token list). */
export function Modal({ open, onClose, title, children, testId, width = 440 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; testId?: string; width?: number }) {
  const d = useDialog(open, onClose);
  const id = useId();
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
    else {
      const t = setTimeout(() => setMounted(false), CLOSE_MS);
      return () => clearTimeout(t);
    }
  }, [open]);
  const panel = useInitialFocus(mounted, open);
  return (
    <dialog {...d} className="overlay" aria-labelledby={id} data-testid={testId} style={{ zIndex: "var(--z-modal)" } as React.CSSProperties}>
      {mounted && (
        <div ref={panel} className="modal-panel outline-none" tabIndex={-1} style={{ "--modal-w": `${width}px` } as React.CSSProperties}>
          <header className="flex items-center gap-3 px-6 pb-2 pt-5">
            <h2 id={id} className="min-w-0 flex-1 text-title font-semibold leading-[26px]">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X size={20} strokeWidth={1.75} aria-hidden />
            </IconButton>
          </header>
          <div className="max-h-[calc(92dvh-72px)] overflow-y-auto px-6 pb-6 pt-2 max-lg:px-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

const ITEMS = '[role="menuitem"],[role="menuitemradio"]';

/**
 * Dropdown menu anchored under its trigger. Keyboard: opening focuses the checked (or first) item, ArrowUp/Down/Home/End
 * move, Esc closes and returns focus to the trigger, tabbing out closes. Outside click closes.
 */
export function Menu({ trigger, children, align = "right", label }: { trigger: (p: { open: boolean; toggle: () => void; id: string }) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; label: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) box.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    (items().find((el) => el.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") return close();
      const list = items();
      if (!list.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    const out = (e: FocusEvent) => {
      if (box.current && e.relatedTarget && !box.current.contains(e.relatedTarget as Node)) setOpen(false);
    };
    const b = box.current;
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    b?.addEventListener("focusout", out);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
      b?.removeEventListener("focusout", out);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="relative" ref={box}>
      {trigger({ open, toggle: () => setOpen((o) => !o), id })}
      {open && (
        <div ref={menu} id={id} role="menu" aria-label={label} className={`menu top-[calc(100%+6px)] ${align === "right" ? "right-0" : "left-0"}`}>
          {children(() => close())}
        </div>
      )}
    </div>
  );
}
