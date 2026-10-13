"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveChain } from "@/lib/activeChain";
import { useNetworkStatus } from "@/lib/network";

/**
 * One small line when reads are failing: "Network busy, retrying…" with a turning icon. Retries are automatic; after
 * 10 s a "Retry now" appears, and "Updated {n} s ago" says how old the data on screen is. Renders nothing when fine.
 */
export function NetworkStatus({ className = "" }: { className?: string }) {
  const s = useNetworkStatus();
  const qc = useQueryClient();
  const { chainId } = useActiveChain();
  const [since, setSince] = useState<number>();
  const [, tick] = useState(0);
  const bad = s.state === "retrying" || s.state === "down";
  useEffect(() => {
    if (bad && since === undefined) setSince(Date.now());
    if (!bad) setSince(undefined);
  }, [bad, since]);
  useEffect(() => {
    if (!bad) return;
    const t = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, [bad]);
  // "retrying automatically" must be true: while down, refetch this network's queries every 15 s
  useEffect(() => {
    if (s.state !== "down") return;
    const t = setInterval(() => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === chainId }), 15_000);
    return () => clearInterval(t);
  }, [s.state, qc, chainId]);
  if (!bad) return null;
  const waited = since ? (Date.now() - since) / 1000 : 0;
  const age = s.lastOk ? Math.round((Date.now() - s.lastOk) / 1000) : undefined;
  return (
    <div role="status" data-testid="network-status" className={`inline-flex flex-wrap items-center gap-x-3 gap-y-1 rounded-full bg-warn-soft px-3 py-1.5 text-caption text-warn shadow-whisper ${className}`}>
      <span className="inline-flex items-center gap-2">
        <RefreshCw size={14} strokeWidth={1.75} className="spin" aria-hidden />
        {s.state === "retrying" ? "Network busy, retrying…" : s.message}
      </span>
      {age !== undefined && age > 5 && (
        <span className="text-ink-2" aria-hidden>
          Updated {age} s ago
        </span>
      )}
      {(waited > 10 || s.state === "down") && (
        <button type="button" className="font-medium underline underline-offset-2" onClick={() => void qc.refetchQueries({ predicate: (q) => q.queryKey[1] === chainId })}>
          Retry now
        </button>
      )}
    </div>
  );
}
