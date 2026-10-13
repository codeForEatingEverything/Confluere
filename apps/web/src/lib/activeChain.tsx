"use client";

/**
 * The active chain is the user's choice: `?chain=` in the URL wins (so shared links open on their network), then the
 * last choice (localStorage `confluere.chain`), then DEFAULT_CHAIN_ID (998). A wallet that connects on a served network is
 * followed (Monad and HyperEVM are symmetric); switching inside the app asks the wallet to follow; when it refuses, the app stays on the chosen network and the action button offers the switch. Wallet-initiated chain
 * changes (the user switches inside the wallet) are followed. The URL always carries the active `?chain=`.
 *
 * Demo mode (lib/demo/mode): the network is the app's choice only. The wallet is never asked to switch and its network
 * is ignored; the URL also carries `?demo=1` while the mode is on, and a link with it turns the mode on.
 */
import { Suspense, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useConnection, useSwitchChain } from "wagmi";
import type { Deployment } from "@confluere/sdk";
import type { Chain } from "viem";
import { DEFAULT_CHAIN_ID, ENABLED, chainIdFromSlug, chainMeta, deploymentOf, isEnabledChain, type ChainMeta } from "./chains";
import { pushToast } from "./txStore";
import { _setLegacyChain } from "./config";
import { DEMO_PARAM, isDemo, setDemo, useDemo } from "./demo/mode";

const KEY = "confluere.chain";

function readStored(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(KEY));
    return isEnabledChain(v) ? v : DEFAULT_CHAIN_ID;
  } catch {
    return DEFAULT_CHAIN_ID;
  }
}

let choice: number = typeof window === "undefined" ? DEFAULT_CHAIN_ID : readStored();
const subs = new Set<() => void>();

/** The read chain chosen in the app (independent of the wallet). */
export const getChainChoice = () => choice;

export function setChainChoice(id: number) {
  if (!isEnabledChain(id) || id === choice) return;
  choice = id;
  try {
    globalThis.localStorage?.setItem(KEY, String(id));
  } catch {}
  subs.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** Store hook for the app's own choice; the server snapshot is the default chain so hydration never mismatches. */
export function useChainChoice(): number {
  return useSyncExternalStore(subscribe, getChainChoice, () => DEFAULT_CHAIN_ID);
}

export type ActiveChain = {
  chainId: number;
  chain: Chain;
  meta: ChainMeta;
  deployment: Deployment | undefined;
  /** Every network the switcher may offer. */
  networks: ChainMeta[];
  /** The wallet's chain id when connected (any chain). */
  walletChainId: number | undefined;
  /** Connected, but the wallet is on a network the app does not serve (or not the active one). */
  walletOnOtherChain: boolean;
};

function compute(choiceId: number, isConnected: boolean, walletChainId: number | undefined, demo = false): ActiveChain {
  const meta = chainMeta(choiceId);
  return {
    chainId: meta.id,
    chain: meta.chain,
    meta,
    deployment: deploymentOf(meta.id),
    networks: ENABLED,
    walletChainId: isConnected ? walletChainId : undefined,
    walletOnOtherChain: !demo && isConnected && walletChainId !== undefined && walletChainId !== meta.id,
  };
}

const Ctx = createContext<ActiveChain | null>(null);

/**
 * Provides the active chain. Children are keyed by the chain id, so a network switch remounts the screen tree:
 * no view can keep state (amounts, selected pool) from the other network. Query caches live outside and stay warm.
 */
export function ActiveChainProvider({ children }: { children: ReactNode }) {
  const { isConnected, chainId: walletChainId } = useConnection();
  const pick = useChainChoice();
  const demo = useDemo();
  const value = useMemo(() => compute(pick, isConnected, walletChainId, demo), [pick, isConnected, walletChainId, demo]);
  // older components read the live-binding exports of lib/config; keep them on the active chain before children render
  _setLegacyChain(value.chainId);
  const sw = useSwitchChain();
  const prev = useRef<{ connected: boolean; chain?: number }>({ connected: false });
  useEffect(() => {
    const p = prev.current;
    prev.current = { connected: isConnected, chain: walletChainId };
    if (!isConnected || walletChainId === undefined || isDemo()) return;
    if (!p.connected) {
      // just connected: the networks are symmetric, so a wallet already on one the app serves is followed (never asked
      // to switch); only a wallet on an unserved network is asked once, and a refusal leaves the app where it is
      if (walletChainId === getChainChoice()) return;
      if (isEnabledChain(walletChainId)) setChainChoice(walletChainId);
      else sw.mutateAsync({ chainId: getChainChoice() }).catch(() => {});
      return;
    }
    // the user changed network inside the wallet: follow it when this app serves that network
    if (p.chain !== undefined && p.chain !== walletChainId && isEnabledChain(walletChainId)) setChainChoice(walletChainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, walletChainId]);
  return (
    <Ctx.Provider value={value}>
      <Suspense fallback={null}>
        <ChainUrlSync chainId={value.chainId} demo={demo} />
      </Suspense>
      <ChainScope key={`${value.chainId}${demo ? ":demo" : ""}`}>{children}</ChainScope>
    </Ctx.Provider>
  );
}

/** URL ↔ choice: a `?chain=` in the URL selects the network; otherwise the active network is written into the URL. */
function ChainUrlSync({ chainId, demo }: { chainId: number; demo?: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname() ?? "/";
  const slug = params?.get("chain");
  const fromUrl = chainIdFromSlug(slug);
  const last = useRef<string | null | undefined>(undefined);
  const demoParam = params?.get(DEMO_PARAM) ?? null;
  const lastDemo = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // a shared demo link turns the demo on; a marker already seen (just before "Exit demo") does not turn it back on
    if (demoParam === "1" && lastDemo.current !== "1" && !isDemo()) {
      lastDemo.current = demoParam;
      setDemo(true);
      return;
    }
    lastDemo.current = demoParam;
    const wantDemo = isDemo();
    // read the live store, not the render's chainId: a strict-mode re-run must not undo a switch it just made
    const live = getChainChoice();
    if (fromUrl !== undefined && slug !== last.current) {
      last.current = slug;
      if (fromUrl !== live) {
        setChainChoice(fromUrl);
        return;
      }
    }
    const want = chainMeta(live).slug;
    if (slug === want && (demoParam === "1") === wantDemo) return;
    const next = new URLSearchParams(params?.toString() ?? "");
    next.set("chain", want);
    if (wantDemo) next.set(DEMO_PARAM, "1");
    else next.delete(DEMO_PARAM);
    last.current = want;
    router.replace(`${path}?${next.toString()}`, { scroll: false });
  }, [slug, fromUrl, chainId, params, path, router, demoParam, demo]);
  return null;
}

/** `href` with the active network attached, for links that name a chain-specific object. */
export function useChainHref() {
  const { meta } = useActiveChain();
  return useCallback(
    (href: string) => {
      const [base, qs = ""] = href.split("?");
      const p = new URLSearchParams(qs);
      p.set("chain", meta.slug);
      return `${base}?${p.toString()}`;
    },
    [meta.slug],
  );
}

const ChainScope = ({ children }: { children: ReactNode }) => <>{children}</>;

/** The active chain (see module comment). Outside the provider (unit tests) it follows the stored choice only. */
export function useActiveChain(): ActiveChain {
  const v = useContext(Ctx);
  const pick = useChainChoice();
  return v ?? compute(pick, false, undefined);
}

/** Shorthand for data hooks. */
export const useActiveChainId = () => useActiveChain().chainId;

export type SwitchResult = { ok: true } | { ok: false; reason: "rejected" | "unsupported" | "failed"; error?: unknown };

/**
 * Switch the network. The app's network changes at once (it is the user's choice); when a wallet is connected it is
 * asked to follow. A refusal keeps the new network for browsing, says so once, and the action buttons offer the switch.
 */
export function useSwitchNetwork() {
  const { isConnected, chainId: walletChainId } = useConnection();
  const sw = useSwitchChain();
  const [error, setError] = useState<unknown>();
  const switchNetwork = useCallback(
    async (id: number): Promise<SwitchResult> => {
      setError(undefined);
      if (!isEnabledChain(id)) return { ok: false, reason: "unsupported" };
      setChainChoice(id);
      if (!isConnected || walletChainId === id || isDemo()) return { ok: true };
      try {
        await sw.mutateAsync({ chainId: id });
        return { ok: true };
      } catch (e) {
        setError(e);
        const msg = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "");
        const rejected = /reject|denied|cancel/i.test(msg) || (e as { code?: number })?.code === 4001;
        pushToast({ status: "info", title: rejected ? `Network switch cancelled in your wallet. You can still browse ${chainMeta(id).label}.` : `Your wallet could not switch to ${chainMeta(id).label}. Change it in the wallet.` });
        return { ok: false, reason: rejected ? "rejected" : "failed", error: e };
      }
    },
    [isConnected, walletChainId, sw],
  );
  return { switchNetwork, switching: sw.isPending, error };
}
