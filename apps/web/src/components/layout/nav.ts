import { ArrowLeftRight, Briefcase, Droplets, HandCoins, LayoutList, PiggyBank, Repeat, type LucideIcon } from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; match: (path: string) => boolean };

/**
 * IA v3.1 (FRONTEND_V3): the top bar shows Borrow · Earn · Loop · LP · Markets · Portfolio. The home page
 * "/" (borrow and repay in one card) is reached through the logo; How it works only through the home page's
 * "Read more" link and the footer.
 */
export const PRIMARY: NavItem[] = [
  { href: "/borrow", label: "Borrow", icon: HandCoins, match: (p) => p.startsWith("/borrow") },
  { href: "/earn", label: "Earn", icon: PiggyBank, match: (p) => p.startsWith("/earn") },
  { href: "/loop", label: "Loop", icon: Repeat, match: (p) => p.startsWith("/loop") },
  { href: "/lp", label: "LP", icon: Droplets, match: (p) => p.startsWith("/lp") || p.startsWith("/seats") },
  { href: "/markets", label: "Markets", icon: LayoutList, match: (p) => p.startsWith("/markets") || p.startsWith("/create") },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase, match: (p) => p.startsWith("/portfolio") },
];

/** Phone tab bar: Home (borrow / repay) · Borrow · Earn · Portfolio, then More. */
export const TABS: NavItem[] = [
  { href: "/", label: "Home", icon: ArrowLeftRight, match: (p) => p === "/" },
  PRIMARY[0]!,
  PRIMARY[1]!,
  PRIMARY[5]!,
];

/** The desktop More menu: the sample-data Demo above Developers. */
export const MORE: { href: string; label: string }[] = [
  { href: "/specials", label: "Specials" },
  { href: "/developers/demo", label: "Demo" },
  { href: "/developers", label: "Developers" },
];

/** The phone More sheet also carries the top-bar entries that have no tab of their own. */
export const MORE_PHONE: { href: string; label: string }[] = [{ href: "/loop", label: "Loop" }, { href: "/lp", label: "LP" }, { href: "/markets", label: "Markets" }, ...MORE];

export const inMore = (path: string) => MORE.some((m) => path.startsWith(m.href));

/** Pages that are not a top-bar destination get a way back. */
export const needsBack = (path: string) => inMore(path) || path.startsWith("/create") || path.startsWith("/how-it-works");

export const GITHUB_URL = "https://github.com/codeForEatingEverything/Confluere";
