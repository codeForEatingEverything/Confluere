"use client";

import Link from "next/link";
import { useActiveChain } from "@/lib/activeChain";
import { networkName } from "@/lib/vocab";
import { fmtExpiry } from "@/lib/format";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/Surface";

/**
 * One empty state for "no open market" on Borrow, Loop, Earn and the home card: what is true (when the last one
 * matured), that the next maturity opens soon, and a link to the matured markets; for lenders also the vaults.
 * Monad and HyperEVM are symmetric: it never sends the person to the other network. Creating a
 * market is a pro tool and lives on the Markets page, not here.
 */
export function NothingOpen({ what, closedTerms, lastExpiry, onVaults, closedLink = true }: { what: "borrow" | "lend" | "loop"; closedTerms: number; lastExpiry?: number; onVaults?: () => void; closedLink?: boolean }) {
  const { meta } = useActiveChain();
  const why =
    closedTerms === 0
      ? "No market has opened here yet."
      : `${closedTerms === 1 ? "The last maturity has" : `All ${closedTerms} maturities have`} passed${lastExpiry ? `; the last matured ${fmtExpiry(lastExpiry)}` : ""}.`;
  const title = what === "loop" ? `No loop market on ${networkName(meta)} right now` : `No open market on ${networkName(meta)} right now`;
  return (
    <EmptyState
      title={title}
      body={
        <>
          <p>
            {why} The next maturity opens soon.
          </p>
          {what === "lend" && onVaults && <p className="mt-1">Vaults still take deposits and lend as soon as a market opens.</p>}
        </>
      }
      actions={
        <>
          {what === "lend" && onVaults && (
            <Button variant="secondary" size="md" onClick={onVaults}>
              Deposit in a vault
            </Button>
          )}
          {closedLink && (
            <Link href="/borrow?closed=1" className="link text-caption">
              See matured markets
            </Link>
          )}
        </>
      }
    />
  );
}
