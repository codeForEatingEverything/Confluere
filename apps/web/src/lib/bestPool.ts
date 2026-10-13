/**
 * Picking the one pool behind the Borrow card (FRONTEND_V3 §8.1.3), pure. Inputs come from lib/product `termsFor`
 * (one Term per maturity, offers sorted by buy-back price, lowest first).
 *
 * - Term chips: open maturities, soonest first, at most four; default the soonest.
 * - Level chips: the term's open buy-back prices, lowest first. One price: no chips. Two: "Repay less" and "More cash
 *   now". Three or more: lowest, median, highest, with "Balanced" (the median) as default.
 */
import type { Offer, Term, StrikeTier } from "./product";

export const MAX_TERM_CHIPS = 4;

export type Level = "low" | "mid" | "high";

export const LEVEL_LABEL: Record<Level, string> = {
  low: "Repay less",
  mid: "Balanced",
  high: "Receive more",
};

export function termChoices(terms: Term[]): Term[] {
  return terms.filter((t) => t.open).slice(0, MAX_TERM_CHIPS);
}

/** One offer per distinct buy-back price among open offers (the first one that is priced wins a tie). */
function distinctOpen(term: Term): Offer[] {
  const out: Offer[] = [];
  for (const o of term.offers.filter((x) => x.open)) {
    const i = out.findIndex((x) => x.strike === o.strike);
    if (i < 0) out.push(o);
    else if (!out[i]!.priced && o.priced) out[i] = o;
  }
  return out;
}

export function levelChoices(term: Term | undefined): { level: Level; offer: Offer }[] {
  if (!term) return [];
  const c = distinctOpen(term);
  if (c.length <= 1) return [];
  if (c.length === 2) return [
    { level: "low", offer: c[0]! },
    { level: "high", offer: c[1]! },
  ];
  return [
    { level: "low", offer: c[0]! },
    { level: "mid", offer: c[Math.floor((c.length - 1) / 2)]! },
    { level: "high", offer: c[c.length - 1]! },
  ];
}

export const defaultLevel = (term: Term | undefined): Level => (levelChoices(term).length === 2 ? "low" : "mid");

/** The pool for a term and level: the chosen chip, or the only open offer. */
export function pickOffer(terms: Term[], expiry: number | undefined, level: Level): { term?: Term; offer?: Offer; levels: { level: Level; offer: Offer }[] } {
  const choices = termChoices(terms);
  const term = choices.find((t) => t.expiry === expiry) ?? choices[0];
  const levels = levelChoices(term);
  if (!term) return { levels };
  if (levels.length === 0) return { term, levels, offer: distinctOpen(term)[0] };
  const offer = (levels.find((l) => l.level === level) ?? levels.find((l) => l.level === defaultLevel(term)) ?? levels[0]!).offer;
  return { term, offer, levels };
}

export type { StrikeTier };

/**
 * The home card's router (IA v3.1 item 1): the person picks collateral and, optionally, a maturity; the router picks
 * the pool. Maturity: the one asked for, else the soonest open one that has traded, else the soonest open one. Pool in
 * that maturity: priced before unpriced, then the cheapest to borrow (lowest fixed rate), then repay-any-time before
 * repay-at-maturity, then established markets. `poolId` is the person's own pick from the card's Pool selector; it wins
 * while it is open in the chosen maturity. `offers` are the maturity's open pools in router order (the selector's list).
 */
export function routeBorrow(terms: Term[], expiry?: number, poolId?: string): { term?: Term; offer?: Offer; terms: Term[]; offers: Offer[]; picked: boolean } {
  const open = termChoices(terms);
  const term = open.find((t) => t.expiry === expiry) ?? open.find((t) => t.offers.some((o) => o.open && o.priced)) ?? open[0];
  if (!term) return { terms: open, offers: [], picked: false };
  const offers = [...term.offers.filter((o) => o.open)].sort(
    (a, b) => Number(b.priced) - Number(a.priced) || a.apr - b.apr || a.pool.kind - b.pool.kind || Number(b.graduated) - Number(a.graduated),
  );
  // the person's own pick (the card's Pool selector) wins while it is still open in this maturity
  const own = poolId ? offers.find((o) => o.id.toLowerCase() === poolId.toLowerCase()) : undefined;
  return { term, offer: own ?? offers[0], terms: open, offers, picked: !!own };
}
