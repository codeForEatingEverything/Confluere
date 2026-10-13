/**
 * Display-only reference price from Kuru's public order book (Monad). Kuru's API sends no CORS headers, so the
 * browser asks this route instead. Returns the mid of the best bid and ask; prices arrive as 1e18 fixed point.
 * Never used on-chain.
 */
import { kuruMid } from "@/lib/kuru";

const KURU = "https://exchange.kuru.io/api/v3/depth";

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("symbol") ?? "";
  if (!/^[A-Z0-9]{2,12}_[A-Z0-9]{2,12}$/.test(symbol)) return Response.json({ price: null }, { status: 400 });
  const r = await fetch(`${KURU}?symbol=${symbol}&limit=1`, { next: { revalidate: 10 } }).catch(() => null);
  if (!r?.ok) return Response.json({ price: null }, { status: 502 });
  const j = (await r.json()) as { bids?: [string, string][]; asks?: [string, string][] };
  const bid = j.bids?.[0]?.[0];
  const ask = j.asks?.[0]?.[0];
  if (!bid || !ask) return Response.json({ price: null });
  return Response.json({ price: kuruMid(bid, ask) });
}

