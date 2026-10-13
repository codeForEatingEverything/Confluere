"use client";

/**
 * The connected account's LP positions (IA v3.1 item 8), for Portfolio: one row per market where the account is the LP,
 * or has money waiting in the LP registry (earnings, a payment for a slot someone took over, a returned bond). The LP
 * token is shown with its stacked-pair icon and can be added to the wallet.
 */
import Link from "next/link";
import { useMemo } from "react";
import { useViewAddress } from "@/lib/demo/hooks";
import type { Address } from "viem";
import { useActiveChain } from "@/lib/activeChain";
import { tokenOf, usePools, useTokens } from "@/lib/data";
import { groupMarkets } from "@/lib/markets";
import { holderUnsplitShare } from "@/lib/seats";
import { exitReturn, isMine, lpSymbol, lpTokenOf, useAddLpToWallet, useSeats } from "@/lib/lp";
import { fmtToken } from "@/lib/format";
import { STYLE_SHORT } from "@/lib/vocab";
import { Button, SectionTitle } from "../ui";
import { LpIcon } from "./LpIcon";

export function LpPositions() {
  const address = useViewAddress();
  const { deployment } = useActiveChain();
  const pools = usePools();
  const markets = useMemo(() => groupMarkets(pools.data ?? []), [pools.data]);
  const seats = useSeats(markets).data;
  const tokens = useTokens(useMemo(() => markets.flatMap((m) => [m.asset, m.quote]) as Address[], [markets])).data;
  const add = useAddLpToWallet();
  const rows = markets
    .map((m) => ({ m, seat: seats?.[m.id] }))
    .filter(({ seat }) => !!seat && (isMine(seat, address) || seat.mine > 0n));
  if (rows.length === 0) return null;
  return (
    <section id="lp" aria-labelledby="lp-title" data-testid="portfolio-lp">
      <SectionTitle id="lp-title">LP</SectionTitle>
      <ul className="card p-2">
        {rows.map(({ m, seat }) => {
          const A = tokenOf(tokens, m.asset);
          const Q = tokenOf(tokens, m.quote);
          const held = isMine(seat, address);
          const waiting = seat!.mine + holderUnsplitShare(seat!, address);
          const token = lpTokenOf(deployment, m);
          return (
            <li key={m.id} className="row flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-control)] px-3 py-3" data-testid="portfolio-lp-row">
              <LpIcon asset={A ?? { address: m.asset }} quote={Q ?? { address: m.quote }} />
              <span className="min-w-0 flex-1">
                <span className="block text-body-sm font-medium text-ink">
                  {A?.symbol ?? "…"} / {Q?.symbol ?? "…"} LP <span className="font-normal text-ink-3">{STYLE_SHORT[m.kind]}</span>
                </span>
                <span className="num block text-caption text-ink-2">
                  {held ? `${fmtToken(exitReturn(seat!), Q, false)} ${lpSymbol(A, Q)}, your price ${fmtToken(seat!.price, Q)}` : "Your slot was taken over or ended"}
                  {waiting > 0n ? `. ${fmtToken(waiting, Q)} to withdraw` : ""}
                </span>
              </span>
              {held && token && A && Q && (
                <Button size="sm" variant="secondary" loading={add.pending} onClick={() => add.add({ token, asset: A.onchainSymbol ?? A.symbol, quote: Q.onchainSymbol ?? Q.symbol, assetAddress: A.address, quoteAddress: Q.address, decimals: Q.decimals })}>
                  Add to wallet
                </Button>
              )}
              <Link href={`/lp?market=${m.id}`} className="btn btn-sm btn-primary">
                {held ? "Manage" : "Withdraw"}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
