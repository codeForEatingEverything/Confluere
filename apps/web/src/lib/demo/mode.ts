/**
 * Demo mode (FRONTEND_V3 IA v3.1 item 13): the same app on sample data with signed-message "transactions". This module
 * is the switch only. It has no dependencies so any layer (chains, data, tx) can ask `isDemo()` without import cycles.
 *
 * - The mode is applied only on the client, after hydration (`bootDemo`), so the server render and the first client
 *   render always match the live app.
 * - It lasts for the browser session (sessionStorage) and travels in links as `?demo=1` (lib/activeChain keeps the
 *   marker in the URL while the mode is on), so a demo link can be shared.
 * - Turning it on or off remounts the whole screen tree and swaps the query cache (app/providers), so nothing from
 *   the live app leaks into the demo or back.
 */
// namespace import: lib/chains (and through it the server routes) imports this module, and Next rejects a named
// client-hook import in the server graph; the hook below only ever runs in client components
import * as React from "react";

export const DEMO_PARAM = "demo";
const KEY = "confluere.demo";

let active = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Whether the app is running on sample data now. Always false on the server and before `bootDemo`. */
export const isDemo = () => active;

const persist = (on: boolean) => {
  try {
    if (on) globalThis.sessionStorage?.setItem(KEY, "1");
    else globalThis.sessionStorage?.removeItem(KEY);
  } catch {}
};

export function setDemo(on: boolean) {
  persist(on);
  if (active === on) return;
  active = on;
  emit();
}

export const enterDemo = () => setDemo(true);
export const exitDemo = () => setDemo(false);

/** The session's stored choice, or a `?demo=1` marker in the current URL. */
export function wantsDemo(search?: string): boolean {
  try {
    const q = new URLSearchParams(search ?? globalThis.location?.search ?? "");
    if (q.get(DEMO_PARAM) === "1") return true;
    return globalThis.sessionStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Apply the stored / linked choice once the app has hydrated. */
export function bootDemo() {
  if (wantsDemo()) setDemo(true);
}

export const subscribeDemo = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** React view of the switch; the server snapshot is the live app so hydration never mismatches. */
export function useDemo(): boolean {
  return React.useSyncExternalStore(subscribeDemo, isDemo, () => false);
}
