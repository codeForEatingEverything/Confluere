"use client";

/**
 * Network health of the active chain, for one small status line ("Network busy, retrying…") instead of silent empty
 * states. Derived from the TanStack query cache: every data query key is [name, chainId, ...] (lib/data), so the
 * status only looks at queries of the active chain that some component is watching.
 */
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useActiveChain } from "./activeChain";

/** Retry delay for reads: 1 s, 2 s, 4 s, capped at 8 s (polling resumes after the last retry). */
export const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000);

export type NetworkState = "ok" | "loading" | "retrying" | "down";

export type NetworkStatus = {
  state: NetworkState;
  /** Plain-language line for the UI, empty when everything is fine. */
  message: string;
  /** How many watched queries are failing right now. */
  failing: number;
  /** Last successful read of any watched query (ms epoch), 0 before the first. */
  lastOk: number;
};

type QueryLike = Pick<Query, "queryKey" | "state"> & { getObserversCount(): number };

/** Pure reduction over the cache (unit-tested). */
export function networkStatusOf(queries: QueryLike[], chainId: number, label: string): NetworkStatus {
  let failing = 0;
  let retrying = 0;
  let loading = 0;
  let lastOk = 0;
  for (const q of queries) {
    if (q.queryKey[1] !== chainId || q.getObserversCount() === 0) continue;
    const s = q.state;
    if (s.dataUpdatedAt > lastOk) lastOk = s.dataUpdatedAt;
    const failedLast = s.errorUpdatedAt > s.dataUpdatedAt;
    if (s.fetchStatus === "fetching" && s.fetchFailureCount > 0) retrying++;
    else if (s.status === "error" || (failedLast && s.fetchStatus !== "fetching")) failing++;
    else if (s.status === "pending" && s.fetchStatus === "fetching") loading++;
  }
  if (retrying > 0) return { state: "retrying", message: "Network busy, retrying…", failing: failing + retrying, lastOk };
  if (failing > 0) return { state: "down", message: `Can't reach ${label} right now. Retrying automatically.`, failing, lastOk };
  if (loading > 0) return { state: "loading", message: "", failing: 0, lastOk };
  return { state: "ok", message: "", failing: 0, lastOk };
}

const same = (a: NetworkStatus, b: NetworkStatus) => a.state === b.state && a.failing === b.failing && a.message === b.message;

/** Network status of the active chain; re-renders only when the state changes. */
export function useNetworkStatus(): NetworkStatus {
  const qc = useQueryClient();
  const { chainId, meta } = useActiveChain();
  const last = useRef<NetworkStatus>({ state: "ok", message: "", failing: 0, lastOk: 0 });
  const get = useCallback(() => {
    const next = networkStatusOf(qc.getQueryCache().getAll() as unknown as QueryLike[], chainId, meta.label);
    if (!same(next, last.current)) last.current = next;
    return last.current;
  }, [qc, chainId, meta.label]);
  // the cache emits while other components render (a new query is added during render); defer so no setState lands mid-render
  const subscribe = useCallback((f: () => void) => qc.getQueryCache().subscribe(() => queueMicrotask(f)), [qc]);
  return useSyncExternalStore(subscribe, get, () => last.current);
}
