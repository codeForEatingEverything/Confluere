"use client";

/**
 * What the demo adds to the screens (IA v3.1 item 13): a DEMO badge on the wordmark and one calm line under the top bar
 * with the way back to the live app. Everything else in demo mode is the same app on sample data.
 */
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { DEMO_PARAM, exitDemo, useDemo } from "@/lib/demo/mode";

/** Leave the demo: the live app, same page, without the demo marker in the URL. */
export function useExitDemo() {
  const router = useRouter();
  const path = usePathname() ?? "/";
  return useCallback(() => {
    exitDemo();
    const next = new URLSearchParams(globalThis.location?.search ?? "");
    next.delete(DEMO_PARAM);
    const qs = next.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  }, [router, path]);
}

export function DemoBadge() {
  if (!useDemo()) return null;
  return (
    <span className="rounded-full bg-brand-soft px-1.5 py-[3px] text-[10px] font-semibold leading-none tracking-wide text-brand-ink" data-testid="demo-badge">
      DEMO
    </span>
  );
}

/** Replaces the testnet line while the demo runs. */
export function DemoStrip() {
  const exit = useExitDemo();
  return (
    <div className="bg-brand-soft text-brand-ink" data-testid="demo-strip">
      <p className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-caption lg:px-6">
        <span>You&apos;re in the demo: sample data, and every action only asks your wallet to sign a message.</span>
        <button type="button" className="font-medium underline underline-offset-2" onClick={exit} data-testid="exit-demo">
          Exit demo
        </button>
      </p>
    </div>
  );
}
