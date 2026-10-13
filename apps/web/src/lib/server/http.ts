/** Small helpers shared by the index route handlers. */
import { servesChain } from "./chainIndex";

export const NO_STORE = { "cache-control": "no-store" };

/** `?chain=` as a served chain id, or a 400 response. */
export function chainParam(req: Request): number | Response {
  const raw = new URL(req.url).searchParams.get("chain");
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || !servesChain(id)) {
    return Response.json({ error: `unsupported chain ${raw ?? "(missing)"}` }, { status: 400, headers: NO_STORE });
  }
  return id;
}

/** `?wait=` in ms (0..5000, default `dflt`): how long a request may wait for a running scan. */
export function waitParam(req: Request, dflt: number): number {
  const w = Number(new URL(req.url).searchParams.get("wait") ?? dflt);
  return Number.isFinite(w) ? Math.max(0, Math.min(5_000, w)) : dflt;
}

export const isHex32 = (s: string | null): s is `0x${string}` => !!s && /^0x[0-9a-fA-F]{64}$/.test(s);
export const isAddress = (s: string | null): s is `0x${string}` => !!s && /^0x[0-9a-fA-F]{40}$/.test(s);
