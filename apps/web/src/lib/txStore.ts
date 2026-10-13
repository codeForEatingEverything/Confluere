/** Global toast list for TxTray: one entry per useTx().run. A tiny external store, no provider needed. */
import { useSyncExternalStore } from "react";
import type { Hex } from "viem";
import type { TxError } from "./txErrors";

export type Toast = {
  id: number;
  status: "success" | "rejected" | "failed" | "info";
  title: string;
  hash?: Hex;
  /** Chain the transaction was sent on (for its explorer link). */
  chainId?: number;
  error?: TxError;
  retry?: () => void;
};

let toasts: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function pushToast(t: Omit<Toast, "id">): number {
  const id = ++seq;
  toasts = [...toasts.slice(-4), { ...t, id }];
  emit();
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => toasts,
    () => toasts,
  );
}
