"use client";

/**
 * Home (IA v3.1 item 1): borrow and repay in one Uniswap-style card, and nothing else. Lending, collecting and
 * position trading live on their own pages. A short intro sits beside the card on desktop (above it on phones) with a link to How it works.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Card } from "../ui";
import { BorrowSwap } from "./BorrowSwap";
import { RepaySwap } from "./RepaySwap";
import { LoopSwap, useHasLoopMarkets } from "./LoopSwap";
import { useDemo } from "@/lib/demo/mode";

type Mode = "borrow" | "repay" | "loop";

/** The four claims, one per line, one colour, all in Georgia italic, the system serif (no download). */
const CLAIMS = ["oracle.", "intermediary.", "MEV.", "slippage."];

const MODE_LABEL: Record<Mode, string> = { borrow: "Borrow", repay: "Repay", loop: "Loop" };

export function HomeScreen() {
  const demo = useDemo();
  const params = useSearchParams();
  const asked = params?.get("mode");
  const [mode, setMode] = useState<Mode>(asked === "repay" || asked === "loop" ? asked : "borrow");
  // Loop is offered only where a loop market exists (the network's coin or its staked version, repay any time)
  const hasLoop = useHasLoopMarkets();
  const modes: Mode[] = hasLoop ? ["borrow", "repay", "loop"] : ["borrow", "repay"];
  const shown: Mode = mode === "loop" && !hasLoop ? "borrow" : mode;
  const [settings, setSettings] = useState(false);
  return (
    <div className="mx-auto grid max-w-[440px] gap-5 max-sm:gap-4 lg:max-w-[1040px] lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start lg:gap-12 lg:py-8">
      <header className="lg:sticky lg:top-24 lg:pt-5" data-testid="home-hero">
        {/* lg:w-fit: the rule below spans exactly the widest claim, so the block reads as one column. */}
        <div className="lg:w-fit">
          <h1>
          <span className="block text-[18px] leading-6 text-ink-2 lg:text-[21px] lg:leading-7">Borrow and lend with</span>
          <span className="mt-3 block font-[Georgia,serif] text-[44px] font-normal italic leading-[1.06] tracking-[-0.005em] text-ink lg:text-[58px]">
            {CLAIMS.map((c) => (
              <span key={c} className="block">
                No {c}
              </span>
            ))}
          </span>
        </h1>
          <div className="mt-6 border-t border-line pt-5 max-sm:mt-5 max-sm:pt-4 lg:mt-8">
            <p className="max-w-[420px] text-body leading-[26px] text-ink-2" data-testid="home-intro">
              Confluere is an outright-repo lending protocol: you sell your tokens for cash and keep the right to buy them back at a fixed price by a fixed date. The cash is
            fully yours to spend, trade or put to work, and your buy-back right is a token you can hold or sell.{" "}
            <Link href="/how-it-works#different" className="link whitespace-nowrap font-medium">
                Read more
              </Link>
            </p>
            {!demo && (
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Link href="/developers/demo" className="btn btn-md btn-secondary" data-testid="home-demo">
                  Try the demo
                </Link>
                <span className="text-caption text-ink-3">The same app on sample data: sign a message, see it fill.</span>
              </div>
            )}
          </div>
        </div>
      </header>
      <div>
      <Card className="p-4 sm:p-5" data-testid="swap-card">
        <div className="mb-3 flex items-center gap-2">
          <div role="tablist" aria-label={hasLoop ? "Borrow, repay or loop" : "Borrow or repay"} className="flex flex-1 items-center gap-1">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={shown === m}
                onClick={() => setMode(m)}
                data-testid={`mode-${m}`}
                className={`h-9 rounded-full px-3.5 text-body font-medium transition-colors ${shown === m ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink"}`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          {shown === "borrow" && (
            <button
              type="button"
              aria-label="Order settings"
              aria-expanded={settings}
              title="Order settings"
              className={`btn btn-icon ${settings ? "bg-surface-2 text-ink" : ""}`}
              onClick={() => setSettings((s) => !s)}
            >
              <Settings2 size={20} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        </div>
        <div role="tabpanel">{shown === "borrow" ? <BorrowSwap settingsOpen={settings} /> : shown === "repay" ? <RepaySwap /> : <LoopSwap />}</div>
      </Card>
      <p className="mt-4 text-center text-caption text-ink-3">
        Want a fixed return instead?{" "}
        <Link href="/earn" className="link">
          Earn
        </Link>{" "}
        or browse every{" "}
        <Link href="/borrow" className="link">
          market
        </Link>
        .
      </p>
      </div>
    </div>
  );
}
