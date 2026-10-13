"use client";

/*
 * Hallmark · component: button · genre: modern-minimal · theme: custom (petrol)
 * states: default · hover · focus · active · disabled · loading · error · success
 * Error lives in the line above the button (ErrorLine); success is carried by the card's status, never by the button.
 */
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "soft" | "quiet" | "danger";
export type ButtonSize = "lg" | "md" | "sm";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
};

/** Keeps a spinner visible for at least 300 ms so a fast step does not flicker. */
function useMinLoading(loading: boolean | undefined, min = 300) {
  const [shown, setShown] = useState(!!loading);
  const since = useRef(0);
  useEffect(() => {
    if (loading) {
      since.current = Date.now();
      setShown(true);
      return;
    }
    const left = min - (Date.now() - since.current);
    if (left <= 0) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(false), left);
    return () => clearTimeout(t);
  }, [loading, min]);
  return shown;
}

export const Spinner = ({ size = 16, className = "" }: { size?: number; className?: string }) => (
  <LoaderCircle size={size} strokeWidth={2} className={`spin ${className}`} aria-hidden />
);

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", loading, block, icon, className = "", children, disabled, type = "button", ...rest },
  ref,
) {
  const busy = useMinLoading(loading);
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      data-loading={busy || undefined}
      aria-busy={busy || undefined}
      className={`btn btn-${size} btn-${variant} ${block ? "w-full" : ""} ${className}`}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
});

/** Square icon button; always has an accessible name. */
export function IconButton({ label, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={`btn btn-icon ${className}`} {...rest}>
      {children}
    </button>
  );
}
