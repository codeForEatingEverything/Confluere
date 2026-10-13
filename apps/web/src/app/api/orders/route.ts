/**
 * An account's order candidates: GET /api/orders?chain=998&owner=0x… -> { status, orders: { pool, id, block }[] }.
 * Orders placed by `owner` with no OrderRemoved yet; the client confirms each with `order(pool, id)`.
 */
import { getIndex, ordersOf, statusOf } from "@/lib/server/chainIndex";
import { NO_STORE, chainParam, isAddress, waitParam } from "@/lib/server/http";

export async function GET(req: Request) {
  const chain = chainParam(req);
  if (chain instanceof Response) return chain;
  const owner = new URL(req.url).searchParams.get("owner");
  if (!isAddress(owner)) return Response.json({ error: "owner must be an address" }, { status: 400, headers: NO_STORE });
  const ix = await getIndex(chain, waitParam(req, 1_200));
  return Response.json({ status: statusOf(ix), orders: ordersOf(ix, owner) }, { headers: NO_STORE });
}
