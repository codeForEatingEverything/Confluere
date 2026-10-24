/**
 * The demo's read seam (IA v3.1 item 13): a stand-in for viem's PublicClient and for this app's /api routes, both
 * answered by the sample network (lib/demo/chain). The data hooks keep their own code; in demo mode
 * `useChainCtx().client` is this client and `appFetch` answers from the sample index, so every screen computes from
 * the same shapes it gets from a real chain.
 */
import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex, type PublicClient } from "viem";
import { chainMeta } from "../chains";
import { isDemo } from "./mode";
import { applyWrite, blockInfo, headBlock, indexBatches, indexOrders, indexPools, indexSeatQuotes, kuruMid, nativeBalance, readCall, spotMid, spotPxRaw, type Call } from "./chain";

const SPOT_PX = "0x0000000000000000000000000000000000000808";

type MulticallArgs = { contracts: readonly Call[]; allowFailure?: boolean };

const clients = new Map<number, PublicClient>();

/** The sample network's client for `chainId` (one per network, stable across renders). */
export function demoClient(chainId: number): PublicClient {
  const hit = clients.get(chainId);
  if (hit) return hit;
  const read = async (c: Call) => readCall(chainId, c);
  const c = {
    chain: chainMeta(chainId).chain,
    type: "publicClient",
    readContract: read,
    multicall: async ({ contracts, allowFailure = true }: MulticallArgs) => {
      if (!allowFailure) return Promise.all(contracts.map(read));
      return Promise.all(contracts.map((x) => read(x).then((result) => ({ status: "success", result }), (error: unknown) => ({ status: "failure", error }))));
    },
    simulateContract: async (w: Call & { account?: Address | { address: Address }; value?: bigint }) => {
      const account = typeof w.account === "string" ? w.account : w.account?.address;
      if (!account) throw new Error("demo: no account");
      applyWrite(chainId, account, w, { simulate: true });
      return { result: undefined, request: w };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash }),
    getBlock: async (o?: { blockNumber?: bigint }) => (o?.blockNumber !== undefined ? blockInfo(chainId, o.blockNumber) : headBlock(chainId)),
    getBlockNumber: async () => headBlock(chainId).number,
    getBalance: async ({ address }: { address: Address }) => nativeBalance(chainId, address),
    call: async ({ to, data }: { to: Address; data?: Hex }) => {
      if (to.toLowerCase() === SPOT_PX && data) {
        const [idx] = decodeAbiParameters([{ type: "uint32" }], data);
        return { data: encodeAbiParameters([{ type: "uint64" }], [spotPxRaw(chainId, Number(idx))]) };
      }
      // tokens answer an unknown selector like a contract with a fallback: never mintable in the demo
      return { data: "0x" as Hex };
    },
    getLogs: async () => [],
    getChainId: async () => chainId,
  };
  const client = c as unknown as PublicClient;
  clients.set(chainId, client);
  return client;
}

/** The sample index for an /api path, or undefined when the path has no demo answer. */
export function demoApi(url: string): unknown {
  const u = new URL(url, "http://demo.local");
  const chain = Number(u.searchParams.get("chain"));
  switch (u.pathname) {
    case "/api/pools":
      return indexPools(chain);
    case "/api/batches":
      return indexBatches(chain, u.searchParams.get("pool") ?? "");
    case "/api/orders":
      return indexOrders(chain, u.searchParams.get("owner") ?? "");
    case "/api/seat-quotes":
      return indexSeatQuotes(chain);
    case "/api/ref/kuru":
      return { price: kuruMid(u.searchParams.get("symbol") ?? "") };
    case "/api/ref/spot":
      return { price: spotMid(u.searchParams.get("symbol") ?? ""), source: "demo" };
  }
  return undefined;
}

/**
 * `fetch` for the app's own JSON routes: the browser's fetch in the live app (same arguments), the sample index in
 * demo mode (an unknown path answers 404, like a route that is not there).
 */
export function appFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!isDemo()) return fetch(url, init);
  try {
    const body = demoApi(url);
    if (body === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  } catch (e) {
    return Promise.reject(e);
  }
}
