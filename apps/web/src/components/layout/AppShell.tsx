"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useActiveChain } from "@/lib/activeChain";
import { LogoMark } from "../LogoMark";
import { DemoBadge, DemoStrip } from "../demo/DemoBits";
import { useDemo } from "@/lib/demo/mode";
import { NetworkStatus } from "../ui/NetworkStatus";
import { ToastRegion } from "../ui/Toast";
import { MoreMenu } from "./MoreMenu";
import { NetworkMenu } from "./NetworkMenu";
import { NotDeployed, worksUndeployed } from "./NotDeployed";
import { WalletMenu, WalletPicker } from "./WalletMenu";
import { GITHUB_URL, PRIMARY, TABS, inMore, needsBack } from "./nav";

function Wordmark() {
  return (
    <Link href="/" className="flex flex-none items-center gap-2.5 rounded-md text-ink" aria-label="Confluere home: borrow or repay">
      <LogoMark size={26} />
      <span className="font-pixel text-[11px] leading-none tracking-normal max-sm:hidden">CONFLUERE</span>
      <DemoBadge />
    </Link>
  );
}

/** Desktop: wordmark (home), Borrow · Earn · Loop · LP · Markets · Portfolio, then network, wallet, More. Phones: wordmark, network, wallet. */
export function TopBar() {
  const path = usePathname() ?? "/";
  return (
    <header className="sticky top-0 bg-surface shadow-[0_1px_0_var(--line)]" style={{ zIndex: "var(--z-sticky)" }}>
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-4 lg:h-16 lg:px-6">
        <Wordmark />
        <nav aria-label="Primary" className="hidden items-center gap-0.5 lg:flex">
          {PRIMARY.map((n) => {
            const on = n.match(path);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={`relative flex h-10 items-center rounded-[var(--radius-control)] px-2.5 xl:px-3 text-body font-medium transition-colors ${on ? "text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
              >
                {n.label}
                {on && <span aria-hidden className="absolute inset-x-2.5 xl:inset-x-3 -bottom-[11px] h-0.5 rounded-full bg-brand" />}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="max-sm:hidden">
            <NetworkMenu />
          </span>
          <span className="sm:hidden">
            <NetworkMenu compact />
          </span>
          <WalletMenu />
          <span className="max-lg:hidden">
            <MoreMenu active={inMore(path)} />
          </span>
        </div>
      </div>
    </header>
  );
}

/** Phones: Home (borrow / repay) · Borrow · Earn · Portfolio, then More, at the bottom. */
export function TabBar() {
  const path = usePathname() ?? "/";
  const moreOn = inMore(path) || path.startsWith("/loop") || path.startsWith("/markets");
  return (
    <nav aria-label="Primary" className="pb-safe fixed inset-x-0 bottom-0 bg-surface shadow-[0_-1px_0_var(--line)] lg:hidden" style={{ zIndex: "var(--z-sticky)" }}>
      <div className="grid h-16 grid-cols-5">
        {TABS.map((n) => {
          const on = n.match(path);
          return (
            <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined} className={`flex flex-col items-center justify-center gap-1 text-label font-medium ${on ? "text-brand" : "text-ink-2"}`}>
              <n.icon size={22} strokeWidth={1.75} aria-hidden />
              {n.label}
            </Link>
          );
        })}
        <MoreMenu tab active={moreOn} />
      </div>
    </nav>
  );
}

/** Pages under More get a way back, so they are never dead ends. */
export function BackHeader() {
  const path = usePathname() ?? "/";
  const router = useRouter();
  if (!needsBack(path)) return null;
  return (
    <button
      type="button"
      className="textbtn mb-4 inline-flex items-center gap-1.5 text-body-sm"
      onClick={() => (typeof window !== "undefined" && window.history.length > 1 ? router.back() : router.push(path.startsWith("/create") ? "/markets" : "/"))}
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden /> Back
    </button>
  );
}

/** Calm, always-visible testnet notice (Stripe "Test mode" pattern); hidden on mainnets. */
export function TestnetStrip() {
  const { meta } = useActiveChain();
  const demo = useDemo();
  if (demo) return <DemoStrip />;
  if (!meta.testnet) return null;
  return (
    <div className="bg-warn-soft text-warn" data-testid="testnet-strip">
      <p className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-2 px-4 py-1.5 text-caption lg:px-6">
        <span>You&apos;re using the beta version on testnet.</span>
        <Link href="/how-it-works#security" className="underline underline-offset-2">
          Learn more
        </Link>
      </p>
    </div>
  );
}

/** Ft2 single line: the only place a middle dot separates links (§6.4). How it works is reached here and from the home page. */
export function Footer() {
  return (
    <footer className="mx-auto max-w-[1200px] px-4 pb-[calc(96px+env(safe-area-inset-bottom))] pt-16 lg:px-6 lg:pb-10">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-3">
        <span className="font-medium text-ink-2">Confluere</span>
        <span aria-hidden>·</span>
        <Link href="/how-it-works" className="textbtn">
          How it works
        </Link>
        <span aria-hidden>·</span>
        <Link href="/developers" className="textbtn">
          Developers
        </Link>
        <span aria-hidden>·</span>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="textbtn">
          GitHub
        </a>
      </p>
    </footer>
  );
}

/** The page, or the calm "not deployed yet" state on a served network without contracts (components/layout/NotDeployed). */
function Page({ children }: { children: ReactNode }) {
  const { deployment } = useActiveChain();
  const path = usePathname() ?? "/";
  return !deployment && !worksUndeployed(path) ? <NotDeployed /> : <>{children}</>;
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#main" className="btn btn-md btn-primary sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4" style={{ zIndex: 600 }}>
        Skip to content
      </a>
      <TopBar />
      <TestnetStrip />
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1200px] px-4 pt-6 outline-none lg:px-6 lg:pt-10">
        <BackHeader />
        <Page>{children}</Page>
      </main>
      <Footer />
      <TabBar />
      <div className="pointer-events-none fixed bottom-[calc(80px+env(safe-area-inset-bottom))] left-4 lg:bottom-6 lg:left-6 [&>*]:pointer-events-auto" style={{ zIndex: "var(--z-toast)" }}>
        <NetworkStatus />
      </div>
      <ToastRegion />
      <WalletPicker />
    </>
  );
}
