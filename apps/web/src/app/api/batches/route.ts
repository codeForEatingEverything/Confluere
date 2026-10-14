/** Clearing-price history of one pool: GET /api/batches?chain=998&pool=0x… -> { status, rows: BatchInfo[] } newest first. */
import { keepScanning, batchesOf, getIndex, statusOf } from "@/lib/server/chainIndex";
import { NO_STORE, chainParam, isHex32, waitParam } from "@/lib/server/http";

// a cold index keeps scanning after the response (keepScanning); give it room on serverless hosts
export const maxDuration = 300;

export async function GET(req: Request) {
  const chain = chainParam(req);
  if (chain instanceof Response) return chain;
  const pool = new URL(req.url).searchParams.get("pool");
  if (!isHex32(pool)) return Response.json({ error: "pool must be a 32-byte hex id" }, { status: 400, headers: NO_STORE });
  const ix = await getIndex(chain, waitParam(req, 1_200));
  keepScanning(ix);
  return Response.json({ status: statusOf(ix), rows: batchesOf(ix, pool) }, { headers: NO_STORE });
}
