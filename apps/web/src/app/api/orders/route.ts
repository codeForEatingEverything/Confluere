/**
 * An account's order candidates: GET /api/orders?chain=998&owner=0x… -> { status, orders: { pool, id, block }[] }.
 * Orders placed by `owner` with no OrderRemoved yet; the client confirms each with `order(pool, id)`.
 */
import { getIndex, keepScanning, ordersOf, statusOf } from "@/lib/server/chainIndex";
import { NO_STORE, chainParam, isAddress, waitParam } from "@/lib/server/http";

// a cold index keeps scanning after the response (keepScanning); give it room on serverless hosts
export const maxDuration = 300;

export async function GET(req: Request) {
  const chain = chainParam(req);
  if (chain instanceof Response) return chain;
  const owner = new URL(req.url).searchParams.get("owner");
  if (!isAddress(owner)) return Response.json({ error: "owner must be an address" }, { status: 400, headers: NO_STORE });
  const ix = await getIndex(chain, waitParam(req, 1_200));
  keepScanning(ix);
  return Response.json({ status: statusOf(ix), orders: ordersOf(ix, owner) }, { headers: NO_STORE });
}
