/**
 * Rules the whole UI must keep (FRONTEND_V3 §4.2, §5.3, §7.8): no protocol words in screens, no AI-style decoration,
 * every old URL moves with a 301, the visual tokens exist in both themes, phones never scroll sideways.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import nextConfig from "../next.config";

const SRC = join(__dirname, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
  });
const screens = [...files(join(SRC, "components")), ...files(join(SRC, "app")).filter((f) => !f.includes("/api/"))];

describe("vocabulary (§4.2 check)", () => {
  it("no protocol term appears in components or pages", () => {
    const banned = /P\*|\bK\b|C-Token|R-Token|\bbatch\b|auction|strike|\bband\b|\bttl\b|\bNC\b|settle|mature\b|WINDOW_BLOCKS/;
    const hits = screens.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => [l, i] as const)
        .filter(([l]) => banned.test(l))
        // the Developers code sample may name contract functions
        .filter(([l]) => !(f.endsWith("DevelopersScreen.tsx") && /flashLoan|onFlashLoan|IERC3156/.test(l)))
        // IA v3.1 item 7: a borrower's leftover from the sale of unrepaid collateral is "auction surplus"
        .filter(([l]) => !(/\/portfolio\//.test(f) && /auction surplus/i.test(l) && !/P\*|\bK\b|strike|\bbatch\b|settle/.test(l)))
        .map(([l, i]) => `${f.replace(SRC, "src")}:${i + 1}: ${l.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("position tokens are named C and R; the interim FT / BR names never appear on screen", () => {
    const banned = /\bFT\b|\bBR\b|Fixed-rate token/;
    const hits = screens.flatMap((f) =>
      readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l, i) => [l, i] as const)
        .filter(([l]) => !/^\s*\/\//.test(l) && banned.test(l))
        .map(([l, i]) => `${f.replace(SRC, "src")}:${i + 1}: ${l.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("no unsolicited token prompts: staking is named only in the Loop card, faucets only in the shortfall helper and Developers", () => {
    for (const f of screens) {
      const s = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/stake/i.test(s.replace(/stakeStep|defaultStakeRate|stakeRate/g, ""))) expect(f).toMatch(/LoopCard|LoopScreen|HowItWorks/);
      if (/faucet/i.test(s)) expect(f).toMatch(/TokenShortfall|DevelopersScreen/);
    }
  });
});

describe("decoration bans (§7.8)", () => {
  // review 3: a middle dot is allowed as a separator in status and meta lines ("Open · 2 min", "Matured · repay now");
  // the error boundary uses the reference wording "Something went wrong" (Uniswap, Stripe).
  it("no gradients except the skeleton shimmer, no blur, no glow, no all-caps labels, no transition-all, no arrow tails", () => {
    for (const f of screens) {
      const s = readFileSync(f, "utf8");
      const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/backdrop-filter|backdrop-blur|text-shadow|transition-all|hover:scale|\buppercase\b|Oops/);
      if (!/error\.tsx$/.test(f)) expect(code, f).not.toMatch(/Something went wrong/);
      expect(code, f).not.toMatch(/→/);
      if (!f.endsWith("globals.css")) expect(code, f).not.toMatch(/linear-gradient|radial-gradient/);
    }
    const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
    expect(css.match(/linear-gradient/g)?.length).toBe(1); // the skeleton
  });
});

describe("visual tokens", () => {
  const css = readFileSync(join(SRC, "app/globals.css"), "utf8");
  it("both themes define the palette; no-JS dark follows the system; reduced motion is honoured", () => {
    for (const t of ["--canvas", "--surface", "--well", "--ink", "--brand", "--brand-soft", "--good", "--warn", "--bad", "--focus", "--shadow-card", "--shadow-overlay"]) {
      expect(css).toContain(`${t}:`);
    }
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/--radius-card: 20px/);
    expect(css).toMatch(/--radius-control: 12px/);
  });
  it("html and body clip horizontal overflow (phones never scroll sideways)", () => {
    expect(css).toMatch(/html,\s*body\s*\{\s*overflow-x: clip;/);
  });
});

describe("routes", () => {
  it("IA v3.1 pages: '/' is the borrow / repay card, /loop is its own page; old URLs moved with 301", async () => {
    const pages = files(join(SRC, "app")).filter((f) => f.endsWith("page.tsx")).map((f) => f.replace(join(SRC, "app"), "") || "/");
    expect(pages).toEqual(expect.arrayContaining(["/borrow/page.tsx", "/create/page.tsx", "/developers/page.tsx", "/earn/page.tsx", "/how-it-works/page.tsx", "/loop/page.tsx", "/markets/page.tsx", "/page.tsx", "/portfolio/page.tsx", "/seats/page.tsx", "/lp/page.tsx", "/developers/demo/page.tsx"]));
    // no page under the old URLs (they redirect)
    expect(pages.filter((p) => /^\/(lend|vaults|market|pool|learn)\//.test(p))).toEqual([]);
    const r = await nextConfig.redirects!();
    const map = Object.fromEntries(r.filter((x) => !("has" in x && x.has)).map((x) => [x.source, x]));
    const want: Record<string, string> = {
      "/borrow/american": "/borrow",
      "/borrow/european": "/borrow?style=european",
      "/lend/american": "/borrow",
      "/lend/european": "/borrow?style=european",
      "/vaults": "/earn#vaults",
      "/vaults/:address": "/earn?vault=:address",
      "/markets/american": "/markets",
      "/markets/european": "/markets?style=european",
      "/market/:id": "/markets?market=:id",
      "/pool/:id": "/markets?pool=:id",
      "/learn": "/how-it-works",
    };
    for (const [from, to] of Object.entries(want)) {
      expect(map[from]?.destination, from).toBe(to);
      expect((map[from] as { statusCode?: number }).statusCode, from).toBe(301);
    }
    // nothing redirects away from the new pages themselves
    for (const p of ["/", "/borrow", "/loop", "/earn"]) expect(map[p], p).toBeUndefined();
    // the old Loop and lend deep links follow their content
    const q = r.filter((x) => "has" in x && x.has);
    expect(q.find((x) => x.source === "/borrow")?.destination).toBe("/loop");
    expect(q.find((x) => x.source === "/earn")?.destination).toBe("/borrow?trade=lend");
  });
});
