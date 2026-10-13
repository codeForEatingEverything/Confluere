/** Seat obligation orders (SeatRegistry Quoted events): GET /api/seat-quotes?chain=998 -> { status, keys: "pool:id"[] }. */
import { getIndex, quoteKeysOf, statusOf } from "@/lib/server/chainIndex";
import { NO_STORE, chainParam, waitParam } from "@/lib/server/http";

export async function GET(req: Request) {
  const chain = chainParam(req);
  if (chain instanceof Response) return chain;
  const ix = await getIndex(chain, waitParam(req, 1_200));
  return Response.json({ status: statusOf(ix), keys: quoteKeysOf(ix) }, { headers: NO_STORE });
}
