"use client";

import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { createAppKit } from "@reown/appkit/react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { wagmiAdapter, wagmiConfig } from "@/lib/wagmi";
import { PROJECT_ID } from "@/lib/config";
import { ENABLED_CHAINS, chainMeta } from "@/lib/chains";
import { ActiveChainProvider, getChainChoice } from "@/lib/activeChain";
import { onThemeApplied, readThemePref, resolveTheme } from "@/lib/theme";
import { appKitThemeOptions } from "@/lib/appkitTheme";
import { retryDelay } from "@/lib/network";
import { setWalletModal } from "@/lib/walletModal";
import { bootDemo, useDemo } from "@/lib/demo/mode";
import { onDemoChange } from "@/lib/demo/chain";

// Wallet layer: AppKit when a Reown project id exists. Swapping to Privy or Dynamic only touches this file.
// Every enabled network is offered; the modal opens on the network the app is showing.
// It takes the site's font, accent and radius (no fonts from fonts.reown.com) and follows the theme toggle.
if (wagmiAdapter && typeof window !== "undefined") {
  const appKit = createAppKit({
    adapters: [wagmiAdapter],
    networks: ENABLED_CHAINS as never,
    defaultNetwork: chainMeta(getChainChoice()).chain as never,
    projectId: PROJECT_ID,
    metadata: { name: "Confluere", description: "Fixed-term borrowing and lending", url: window.location.origin, icons: [`${window.location.origin}/icon.svg`] },
    // the app shows its own wrong-network state on the network pill and the action button
    allowUnsupportedChain: true,
    features: { analytics: false, swaps: false, onramp: false, email: false, socials: false },
    ...appKitThemeOptions(resolveTheme(readThemePref())),
  });
  onThemeApplied((mode) => appKit.setThemeMode(mode));
  setWalletModal(appKit);
}

/** Public RPCs drop or rate-limit bursts: reads retry three times with backoff (lib/network retryDelay). */
/** Query and mutation failures are shown by the components that own them (and lib/network); never console.error. */
const quiet = (e: unknown) => {
  if (process.env.NODE_ENV !== "production") console.debug("[query]", e);
};

export function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: quiet }),
    mutationCache: new MutationCache({ onError: quiet }),
    defaultOptions: {
      queries: { retry: 3, retryDelay, throwOnError: false, refetchOnWindowFocus: false, staleTime: 2_000 },
      mutations: { throwOnError: false },
    },
  });
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Demo mode (lib/demo): applied once the app has hydrated. It runs on its own query cache, so nothing read from a chain
 * shows in the demo and nothing from the demo shows in the live app; screens refresh when a sample round runs.
 */
function DemoRefresh() {
  const qc = useQueryClient();
  useEffect(() => {
    const off = onDemoChange((chainId, kind) => {
      if (kind === "round") void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === chainId });
    });
    return () => void off();
  }, [qc]);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(makeQueryClient);
  const [demoQc] = useState(makeQueryClient);
  const demo = useDemo();
  useIsoLayoutEffect(() => bootDemo(), []);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={demo ? demoQc : qc}>
        {demo && <DemoRefresh />}
        <ActiveChainProvider>{children}</ActiveChainProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
