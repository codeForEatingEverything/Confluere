"use client";

/**
 * Shareable drawer state in the query string (?pool=, ?vault=, ?market=, ?position=). Opening a drawer pushes a history
 * entry, so the browser / system Back gesture closes it; closing a drawer the app opened goes back, closing one that
 * arrived by link replaces the URL. Other params (including `?chain=`) are kept, so links stay network-safe.
 */
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const KEY = "confluere.pushed";

/** The setter's optional second argument sets (or, with undefined, removes) other params in the same URL change. */
export type SetParam = (v: string | undefined, extra?: Record<string, string | undefined>) => void;

export function useQueryParam(name: string): [string | undefined, SetParam] {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname() ?? "/";
  const value = params?.get(name) ?? undefined;
  const set = useCallback(
    (v: string | undefined, extra?: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params?.toString() ?? "");
      if (v === undefined || v === "") next.delete(name);
      else next.set(name, v);
      for (const [k, x] of Object.entries(extra ?? {})) {
        if (x === undefined || x === "") next.delete(k);
        else next.set(k, x);
      }
      const qs = next.toString();
      const url = `${path}${qs ? `?${qs}` : ""}`;
      const opening = v !== undefined && v !== "" && value === undefined;
      const closing = (v === undefined || v === "") && value !== undefined;
      let pushed: string | null = null;
      try {
        pushed = sessionStorage.getItem(KEY);
      } catch {}
      if (opening) {
        try {
          sessionStorage.setItem(KEY, url);
        } catch {}
        router.push(url, { scroll: false });
      } else if (closing && pushed && typeof window !== "undefined" && pushed === window.location.pathname + window.location.search) {
        try {
          sessionStorage.removeItem(KEY);
        } catch {}
        router.back();
      } else router.replace(url, { scroll: false });
    },
    [params, router, path, name, value],
  );
  return [value, set];
}
