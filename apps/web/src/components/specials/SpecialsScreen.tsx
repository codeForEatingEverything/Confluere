"use client";

/**
 * Specials (BLUEPRINT v0.8 §7.9, decision A): borrow the asset itself out of a European pool against 120% margin in
 * the loan token, and hand the same token back by the Thursday deadline. Reads go through the pool list; the lend /
 * return writes need the Specials periphery, which is shown as not live until the deployment carries its address.
 */
import { useMemo } from "react";
import type { Address } from "viem";
import { Kind, scaleOf } from "@confluere/sdk";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, usePools, useTokens } from "@/lib/data";
import { fmtChip, fmtPer, fmtToken } from "@/lib/format";
import { canLend, lendDeadline, minMargin } from "@/lib/specials";
import { Button, Card, useLiveNow } from "../ui";

export function SpecialsScreen() {
  const { deployment } = useActiveChain();
  const now = useLiveNow();
  const pools = usePools().data ?? [];
  const tokens = useTokens(useMemo(() => [...new Set(pools.flatMap((p) => [p.asset, p.quote]))] as Address[], [pools])).data;
  const live = !!(deployment as { specials?: Address } | undefined)?.specials;
  const rows = now ? pools.filter((p) => canLend(p, now)) : [];
  const europeanCount = pools.filter((p) => p.kind === Kind.European).length;

  return (
    <div className="mx-auto max-w-[720px]">
      <h1 className="text-amount font-semibold leading-8">Specials</h1>
      <p className="mt-2 text-body leading-6 text-ink-2">
        Borrow the token itself from a pay-at-maturity pool. Post 120% of its value in the loan token as margin, and return the same token before the deadline to get the margin back.
      </p>
      <Card className="mt-6 space-y-2 p-6 max-sm:p-4">
        <p className="text-body-sm font-medium">How it works</p>
        <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-2">
          <li>Only pay-at-maturity pools lend: their collateral sits untouched until the repayment window.</li>
          <li>Margin is at least 120% of the units at the pool&apos;s last traded price. You can add margin any time.</li>
          <li>Return deadline: Thursday 20:00 UTC, half a day before the Friday maturity.</li>
          <li>Late: there is no forced buy-in. Units still out become the pool&apos;s shortfall and your whole margin goes into the pool.</li>
          <li>Borrowers who repay get the pool&apos;s token first; if it is short, they get their repayment back plus a share of the forfeited margin. Margin nobody claims goes to lenders when the window closes.</li>
        </ul>
      </Card>
      <Card className="mt-4 p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-body-sm text-ink-2">{europeanCount === 0 ? "No pay-at-maturity pools on this network yet." : "No pay-at-maturity pool can lend right now: it needs a traded price, tokens in the pool, and time before the deadline."}</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((p) => {
              const A = tokenOf(tokens, p.asset);
              const Q = tokenOf(tokens, p.quote);
              const one = scaleOf(p.assetDecimals);
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 max-sm:px-4" data-testid="special-row">
                  <div className="space-y-0.5">
                    <p className="text-body-sm font-medium">
                      {A?.symbol ?? "Asset"} · matures {fmtChip(p.expiry)}
                    </p>
                    <p className="text-caption text-ink-2">
                      Available {fmtToken(p.assetBal, A)} · margin per 1 {A?.symbol}: <span className="num">{fmtPer(minMargin(one, p.lastClearingPrice, one), Q)}</span> {Q?.symbol} · return by {fmtChip(lendDeadline(p.expiry))}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" disabled={!live}>
                    {live ? "Borrow token" : "Not live on this network"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
