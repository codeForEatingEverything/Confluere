/**
 * Pool discovery per chain: GET /api/pools?chain=998 -> { status, pools: PoolInfo[], last: { poolId: BatchInfo } }.
 * Served from the server's event index (lib/server/chainIndex): seeded with the deployment's pool ids, filled by an
 * incremental PoolCreated scan. `status.complete` is false while the first backfill is still running.
 */
import { getIndex, keepScanning, lastBatchOf, poolsOf, statusOf } from "@/lib/server/chainIndex";
import { NO_STORE, chainParam, waitParam } from "@/lib/server/http";

// a cold index keeps scanning after the response (keepScanning); give it room on serverless hosts
export const maxDuration = 300;

export async function GET(req: Request) {
  const chain = chainParam(req);
  if (chain instanceof Response) return chain;
  const ix = await getIndex(chain, waitParam(req, 1_200));
  keepScanning(ix);
  return Response.json({ status: statusOf(ix), pools: poolsOf(ix), last: lastBatchOf(ix) }, { headers: NO_STORE });
}
