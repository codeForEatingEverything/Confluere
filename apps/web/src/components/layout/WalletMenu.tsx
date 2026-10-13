"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowUpRight, Briefcase, Check, ChevronDown, Copy, LogOut, Wallet } from "lucide-react";
import { useBalance, useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { useActiveChain, useSwitchNetwork } from "@/lib/activeChain";
import { explorerAddressUrl } from "@/lib/chains";
import { fmtToken, short } from "@/lib/format";
import { openWalletPicker, walletModal, walletPickerStore } from "@/lib/walletModal";
import { useDemo } from "@/lib/demo/mode";
import { useDemoNativeBalance } from "@/lib/demo/hooks";
import { Button, type ButtonSize } from "../ui/Button";
import { Menu, Modal } from "../ui/Overlay";

/** Open the wallet picker: AppKit when configured, else the app's own list of detected browser wallets. */
export function useConnectWallet() {
  const { isPending } = useConnect();
  return {
    connecting: isPending,
    connect: () => {
      const m = walletModal();
      if (m) return void m.open();
      openWalletPicker(true);
    },
  };
}

/** Fallback picker: one row per EIP-6963 wallet the browser announced (logo, name), "Connecting…" on the clicked row. */
export function WalletPicker() {
  const open = useSyncExternalStore(walletPickerStore.subscribe, walletPickerStore.get, () => false);
  const connectors = useConnectors();
  const { mutate: connect, isPending, variables } = useConnect();
  const [err, setErr] = useState<string>();
  const list = connectors.filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i);
  const close = () => {
    setErr(undefined);
    openWalletPicker(false);
  };
  return (
    <Modal open={open} onClose={close} title="Connect a wallet" testId="wallet-picker">
      {list.length === 0 ? (
        <p className="text-body-sm text-ink-2">No browser wallet found. Install MetaMask or Rabby, or open this page in your wallet&apos;s browser.</p>
      ) : (
        <ul className="-mx-2">
          {list.map((c) => {
            const busy = isPending && variables?.connector === c;
            return (
              <li key={c.uid}>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() =>
                    connect(
                      { connector: c },
                      {
                        onSuccess: close,
                        onError: (e) => {
                          const m = String((e as { shortMessage?: string }).shortMessage ?? e.message);
                          if (/reject|denied|cancel/i.test(m)) return;
                          setErr(/not found|ProviderNotFound/i.test(m) ? `${c.name} is not available in this browser.` : /already pending/i.test(m) ? `Open ${c.name}: a connection request is waiting there.` : `Could not connect to ${c.name}.`);
                        },
                      },
                    )
                  }
                  className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-control)] px-2 text-left hover:bg-surface-2 disabled:opacity-60"
                >
                  {c.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.icon} alt="" width={32} height={32} className="h-8 w-8 flex-none rounded-lg" />
                  ) : (
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-surface-2 text-ink-2">
                      <Wallet size={18} strokeWidth={1.75} aria-hidden />
                    </span>
                  )}
                  <span className="flex-1 text-body font-medium">{c.name}</span>
                  {busy && <span className="text-caption text-ink-3">Connecting…</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {err && (
        <p role="alert" className="mt-3 text-caption text-bad">
          {err}
        </p>
      )}
      <p className="mt-4 text-caption text-ink-3">New to wallets? A wallet holds your tokens and signs each transaction; nothing moves without your approval.</p>
    </Modal>
  );
}

/** Deterministic 5×5 mirrored identicon from the address, in the pixel language of the logo. */
export function Identicon({ address, size = 20 }: { address: string; size?: number }) {
  const h = address.toLowerCase().slice(2);
  const cells: [number, number][] = [];
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      if (parseInt(h[(y * 3 + x) % 40]!, 16) % 2 === 0) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
    }
  const accent = parseInt(h.slice(30, 32), 16) % cells.length;
  return (
    <svg width={size} height={size} viewBox="-1 -1 7 7" className="flex-none rounded-full bg-surface-2" aria-hidden>
      {cells.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={1} height={1} fill={i === accent ? "var(--brand)" : "var(--ink-2)"} />
      ))}
    </svg>
  );
}

/**
 * The card's main button, gated by the wallet: "Connect wallet" when none, "Switch to {network}" when the wallet is on
 * another network, otherwise the action itself.
 */
export function WalletAction({ children, size = "lg" }: { children: ReactNode; size?: ButtonSize }) {
  const { isConnected } = useConnection();
  const { connect, connecting } = useConnectWallet();
  const { chainId, meta, walletOnOtherChain } = useActiveChain();
  const { switchNetwork, switching } = useSwitchNetwork();
  if (!isConnected)
    return (
      <Button variant="primary" size={size} block loading={connecting} onClick={connect} icon={<Wallet size={18} strokeWidth={1.75} aria-hidden />}>
        Connect wallet
      </Button>
    );
  if (walletOnOtherChain)
    return (
      <Button variant="primary" size={size} block loading={switching} onClick={() => void switchNetwork(chainId)}>
        Switch to {meta.label}
      </Button>
    );
  return <>{children}</>;
}

/** Top-bar wallet: a soft "Connect" button, or avatar + short address opening a menu with balance and actions. */
export function WalletMenu() {
  const { address, isConnected, connector } = useConnection();
  const { connect, connecting } = useConnectWallet();
  const { disconnect } = useDisconnect();
  const { chainId, meta } = useActiveChain();
  const [copied, setCopied] = useState(false);
  const demo = useDemo();
  const live = useBalance({ address, chainId, query: { enabled: !!address && !demo, refetchInterval: 30_000 } }).data;
  const sample = useDemoNativeBalance(address, chainId);
  const bal = demo ? (sample === undefined ? undefined : { value: sample, decimals: 18 }) : live;
  if (!isConnected || !address)
    return (
      <Button variant="soft" size="md" loading={connecting} onClick={connect} className="max-sm:px-3" aria-label="Connect wallet">
        <span className="sm:hidden">Connect</span>
        <span className="max-sm:hidden">Connect wallet</span>
      </Button>
    );
  const url = explorerAddressUrl(chainId, address);
  return (
    <Menu
      label="Wallet"
      trigger={({ open, toggle, id }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="menu" className="btn btn-md btn-secondary gap-2 px-2.5" data-testid="wallet-menu">
          <Identicon address={address} />
          <span className="mono text-ink">{short(address)}</span>
          <ChevronDown size={16} strokeWidth={1.75} className="text-ink-3 max-sm:hidden" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div className="w-[260px]">
          <div className="flex items-center gap-3 px-2.5 pb-3 pt-2">
            <Identicon address={address} size={32} />
            <div className="min-w-0">
              <p className="mono text-ink">{short(address)}</p>
              <p className="tabular-nums text-caption text-ink-3">
                {bal ? `${fmtToken(bal.value, { decimals: bal.decimals, symbol: meta.native })}` : "…"} on {meta.label}
              </p>
              {connector?.name && <p className="text-caption text-ink-3">via {connector.name}</p>}
            </div>
          </div>
          <div className="mx-1 mb-1 h-px bg-line" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() =>
              void navigator.clipboard?.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => {
                  setCopied(false);
                  close();
                }, 1200);
              })
            }
          >
            {copied ? <Check size={16} strokeWidth={1.75} className="text-good" aria-hidden /> : <Copy size={16} strokeWidth={1.75} aria-hidden />} {copied ? "Copied" : "Copy address"}
          </button>
          {url && (
            <a role="menuitem" className="menu-item" href={url} target="_blank" rel="noreferrer" onClick={close}>
              <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden /> View on explorer
            </a>
          )}
          <Link role="menuitem" className="menu-item" href="/portfolio" onClick={close}>
            <Briefcase size={16} strokeWidth={1.75} aria-hidden /> Portfolio
          </Link>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              disconnect();
              close();
            }}
          >
            <LogOut size={16} strokeWidth={1.75} aria-hidden /> Disconnect
          </button>
        </div>
      )}
    </Menu>
  );
}
