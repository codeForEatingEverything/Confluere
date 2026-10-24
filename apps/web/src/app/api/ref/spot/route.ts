/**
 * Display-only mainnet spot price, for networks without a market worth quoting (Sepolia: ETH / USD for WETH / USDC and,
 * times wstETH's own rate, wstETH / USDC). GET /api/ref/spot?symbol=ETH_USD -> { price, source }. Asks Coinbase, then
 * Kraken; each answer is cached for 30 s, and when both fail the route answers `{ price: null }` (status 502) so the
 * screens simply show no reference. Never used on-chain.
 */
import { SPOT_PAIRS, coinbaseSpot, krakenLast } from "@/lib/spot";

const TTL_S = 30;

async function ask(url: string, parse: (j: unknown) => number | null): Promise<number | null> {
  try {
    const r = await fetch(url, { next: { revalidate: TTL_S }, signal: AbortSignal.timeout(4_000) });
    return r.ok ? parse(await r.json()) : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("symbol") ?? "";
  const pair = Object.hasOwn(SPOT_PAIRS, symbol) ? SPOT_PAIRS[symbol] : undefined; // not toString / __proto__
  if (!pair) return Response.json({ price: null }, { status: 400 });
  const cache = { "cache-control": `public, max-age=${TTL_S}` };
  const cb = await ask(`https://api.coinbase.com/v2/prices/${pair.coinbase}/spot`, coinbaseSpot);
  if (cb !== null) return Response.json({ price: cb, source: "coinbase" }, { headers: cache });
  const kr = await ask(`https://api.kraken.com/0/public/Ticker?pair=${pair.kraken}`, krakenLast);
  if (kr !== null) return Response.json({ price: kr, source: "kraken" }, { headers: cache });
  return Response.json({ price: null }, { status: 502 });
}
