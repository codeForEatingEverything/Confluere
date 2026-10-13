/**
 * LP token icon (IA v3.1 item 8): the pair's two token logos stacked, with a small "LP" badge, as one SVG.
 * GET /api/lp-icon?chain=998&asset=0x…&quote=0x… . Used by wallet_watchAsset, so the logos are embedded as data URIs
 * (a wallet renders the file on its own, without fetching anything else).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenLogo } from "@/lib/logos";

const embed = (path: string | undefined): string | undefined => {
  if (!path || !/^\/tokens\/\d+\/0x[0-9a-f]{40}\.(svg|png)$/.test(path)) return undefined;
  try {
    const buf = readFileSync(join(process.cwd(), "public", path));
    return `data:${path.endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
};

function lpIconSvg(a?: string, q?: string): string {
  const disc = (href: string | undefined, cx: number, id: string) =>
    href
      ? `<clipPath id="${id}"><circle cx="${cx}" cy="30" r="20"/></clipPath><circle cx="${cx}" cy="30" r="21.5" fill="#fff"/><image href="${href}" x="${cx - 20}" y="10" width="40" height="40" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>`
      : `<circle cx="${cx}" cy="30" r="21.5" fill="#fff"/><circle cx="${cx}" cy="30" r="20" fill="#dfe7e8"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">`,
    disc(q, 60, "q"),
    disc(a, 36, "a"),
    `<rect x="26" y="58" width="44" height="26" rx="13" fill="#0f5c63" stroke="#fff" stroke-width="3"/>`,
    `<text x="48" y="76" text-anchor="middle" font-family="Inter, Helvetica, Arial, sans-serif" font-size="15" font-weight="700" fill="#fff">LP</text>`,
    `</svg>`,
  ].join("");
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const chain = Number(u.searchParams.get("chain") ?? 0);
  const addr = (k: string) => {
    const v = u.searchParams.get(k) ?? "";
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : undefined;
  };
  const a = embed(tokenLogo(chain, addr("asset")));
  const q = embed(tokenLogo(chain, addr("quote")));
  return new Response(lpIconSvg(a, q), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}
