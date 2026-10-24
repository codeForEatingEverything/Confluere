"use client";

/** How it works (More): what happens when you borrow, when you lend, and what never happens. Plain words only. */
import Link from "next/link";
import { Card } from "../ui";
import { ANVIL, ENABLED, deploymentOf } from "@/lib/chains";
import { networkName } from "@/lib/vocab";

/** One sentence, used verbatim on Borrow and here. */
export const PROMISE = "Fixed-term borrowing against your tokens. Post collateral, receive the loan now, buy the collateral back by the deadline, or keep the proceeds.";

export const STEPS = [
  { t: "Today", b: "You post collateral. It is sold into a market with a fixed maturity: you receive the loan now plus the right to buy the collateral back at a price fixed today." },
  { t: "Until maturity", b: "Nothing can force a sale. No price feed watches your position, nobody can liquidate it, and the market price of your collateral doesn't matter." },
  { t: "By the deadline", b: "Repay the fixed amount and get your collateral back, or don't: you keep the proceeds and the lenders keep the collateral. No penalty, nothing else happens." },
];

/** What sets Confluere apart (the home page's four claims, explained). */
const DIFFERENT = [
  { t: "Outright repo, not a collateral loan", b: "Your tokens are sold to the lenders, not locked as collateral, and you keep the right to buy them back. Ownership really moves, so there is no margin call and no liquidation, whatever the market does." },
  { t: "No oracle", b: "Repayment compares token amounts and dates only. No price feed can be manipulated, go stale or trigger a sale." },
  { t: "No intermediary", b: "Borrowers and lenders meet in an immutable contract. No curator picks your risk, no liquidator profits from your position, no owner can change the rules." },
  { t: "No MEV", b: "Orders gather for a round and fill together at one price. There is no execution order to front-run or sandwich." },
  { t: "No slippage", b: "You set the worst price you accept. An order never fills beyond it; if a round's price is worse, it waits or comes back to you." },
  { t: "Fixed rate, fixed date", b: "Your rate is set when your order fills and does not move until maturity. You know today exactly what you repay and when." },
];

const LIMITS = [
  "Once a position starts it is never closed early. A roll-over to the next maturity can fail to fill; the current position then stays as it is.",
  "In markets where you can repay any time, lenders may be paid back before the date.",
  "Vault withdrawals are paid in one token. A vault only lends into markets that sell unrepaid collateral into the next maturity, so a withdrawal can wait for that sale.",
  "Every loan of the same date shares one repayment window, counted in blocks after the date. A pause of the network pauses it too.",
  "If a token's issuer can freeze transfers, repaying, claiming and withdrawing that token stop while it is frozen.",
  "Anyone can open a market. New markets are marked, vaults don't lend there yet, and a guardian may pause them for up to 7 days in total.",
];

const SECURITY = [
  "Contracts are immutable: no owner, no upgrade, no admin keys.",
  "Only privilege: a guardian may pause a new market for up to 7 days in total. It cannot move funds.",
  "Internal audit, October 2026 (docs/AUDIT_2026-10-11.md on GitHub). No external audit yet.",
  deploymentLine(),
];

/**
 * Where it runs, from the deployments this build has: "Testnet deployment on Monad Testnet and HyperEVM Testnet, same
 * code at the same address." plus a served network that is not deployed yet (Sepolia before its deploy).
 */
export function deploymentLine(): string {
  const nets = ENABLED.filter((c) => c.id !== ANVIL);
  const live = nets.filter((c) => !!deploymentOf(c.id));
  const later = nets.filter((c) => !deploymentOf(c.id));
  const list = (xs: typeof nets) => xs.map(networkName).join(xs.length > 2 ? ", " : " and ").replace(/, ([^,]+)$/, " and $1");
  const cores = new Set(live.map((c) => deploymentOf(c.id)!.confluere.toLowerCase()));
  const where = live.length === 0 ? "" : `Testnet deployment on ${list(live)}${live.length > 1 ? (cores.size === 1 ? ", same code at the same address" : ", same code") : ""}. `;
  const soon = later.length === 0 ? "" : `${list(later)} ${later.length > 1 ? "are" : "is"} supported and not deployed yet. `;
  return `${where}${soon}Test tokens have no value.`;
}

export function HowItWorks() {
  return (
    <div className="max-w-[880px]">
      <h1 className="text-amount font-semibold leading-8">How it works</h1>
      <p className="mt-2 max-w-[65ch] text-body text-ink-2">{PROMISE} Because the collateral is sold with a right to buy it back (a repo), there is no liquidation.</p>

      <Card className="mt-8 p-2">
        <ol aria-label="A loan from start to end">
          {STEPS.map((s, i) => (
            <li key={s.t} className="row grid grid-cols-[32px_minmax(0,1fr)] gap-x-4 rounded-[var(--radius-control)] px-4 py-4 sm:grid-cols-[32px_140px_minmax(0,1fr)]">
              <span className="num flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-body-sm font-semibold text-brand-ink">{i + 1}</span>
              <p className="self-center text-body font-semibold">{s.t}</p>
              <p className="col-start-2 mt-1 text-body-sm leading-6 text-ink-2 sm:col-start-3 sm:mt-0 sm:self-center">{s.b}</p>
            </li>
          ))}
        </ol>
      </Card>

      <section className="mt-12 space-y-3" id="different">
        <h2 className="text-title font-semibold">How Confluere is different</h2>
        <ul className="card p-2">
          {DIFFERENT.map((d) => (
            <li key={d.t} className="row grid gap-x-6 gap-y-1 rounded-[var(--radius-control)] px-4 py-4 sm:grid-cols-[220px_minmax(0,1fr)]">
              <p className="text-body font-semibold text-ink">{d.t}</p>
              <p className="text-body-sm leading-6 text-ink-2">{d.b}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12 space-y-3">
        <h2 className="text-title font-semibold">When you borrow</h2>
        <p className="max-w-[65ch] text-body leading-6 text-ink-2">
          You post collateral; it is sold at the price of the next round (about every 2 minutes on the test networks, one price for everyone in the round) and you receive the loan. The card shows exactly how much to repay and by when. Repay before the
          deadline to buy the collateral back; if you don&apos;t, you keep the proceeds and owe nothing.
        </p>
      </section>
      <section className="mt-8 space-y-3">
        <h2 className="text-title font-semibold">When you lend</h2>
        <p className="max-w-[65ch] text-body leading-6 text-ink-2">
          You buy lender units below the buy-back price. If the borrower repays, you are paid the buy-back price, which is your fixed rate to maturity. If not, you receive the collateral instead. A vault
          lends for you by a rule fixed at deployment.
        </p>
      </section>
      <section className="mt-8 space-y-3" id="fees">
        <h2 className="text-title font-semibold">Fees</h2>
        <ul className="max-w-[65ch] list-disc space-y-1 pl-5 text-body leading-6 text-ink-2">
          <li>Every trade pays 0.015% of its value on each side (0.03% in all). It goes to the protocol, repaid or not.</li>
          <li>
            5% of the interest (buy-back price minus the round&apos;s price) is taken from what the borrower receives and held in the market. When the repayment window
            closes it is split by the share that was repaid: that part goes to the protocol, the rest goes to lenders, who kept the collateral instead.
          </li>
          <li>Repaying costs nothing beyond the buy-back price. Quotes on every card already include these fees.</li>
          <li>A new market becomes established after four clean maturities in a row, each earning the protocol a fixed minimum in fees.</li>
        </ul>
      </section>
      <section className="mt-8 space-y-3">
        <h2 className="text-title font-semibold">What never happens</h2>
        <ul className="max-w-[65ch] list-disc space-y-1 pl-5 text-body leading-6 text-ink-2">
          <li>No price feed decides anything. Prices shown as &quot;price now&quot; are for reference only.</li>
          <li>No liquidation, and no sale of your tokens on an exchange.</li>
          <li>No one manages risk for you: no curator, no owner, no upgrade.</li>
        </ul>
      </section>
      <section className="mt-12 space-y-3">
        <h2 className="text-title font-semibold">Known limits</h2>
        <ul className="card p-2">
          {LIMITS.map((l) => (
            <li key={l} className="row px-3 py-3 text-body-sm leading-6 text-ink-2">
              {l}
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-12 space-y-3" id="security">
        <h2 className="text-title font-medium">Security and status</h2>
        <ul className="card p-2">
          {SECURITY.map((l) => (
            <li key={l} className="row px-3 py-3 text-body-sm text-ink-2">
              {l}
            </li>
          ))}
        </ul>
      </section>
      <p className="mt-10 text-body-sm text-ink-2">
        Ready?{" "}
        <Link href="/borrow" className="link">
          Borrow
        </Link>{" "}
        or{" "}
        <Link href="/earn" className="link">
          Earn
        </Link>
        .
      </p>
    </div>
  );
}
