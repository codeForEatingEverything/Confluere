import { createServer, type Server } from "node:http";
import { confluereAbi, Side } from "@confluere/sdk";
import type { Address, Hex } from "viem";
import type { Clients } from "./chain.js";

/**
 * GET /hint?pool=0x..&side=0|1|4&limit=123 -> {"hint":"42"}
 * Stateless: answers with the core's own findHint view. A stale hint is tolerated on-chain (3-node probe).
 */
export function startHintServer(c: Clients, core: Address, port: number): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/hint") {
        res.writeHead(404).end();
        return;
      }
      const pool = url.searchParams.get("pool") as Hex;
      const side = Number(url.searchParams.get("side"));
      const limit = BigInt(url.searchParams.get("limit") ?? "0");
      if (![Side.Sell, Side.Buy, Side.Bid].includes(side)) throw new Error("side must be 0, 1 or 4");
      const hint = await c.pub.readContract({ address: core, abi: confluereAbi, functionName: "findHint", args: [pool, side, limit] });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ hint: hint.toString() }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
    }
  });
  server.listen(port);
  return server;
}
