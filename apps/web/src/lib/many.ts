import type { PublicClient } from "viem";

type Call = { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/**
 * Batched reads. Uses Multicall3 when the chain definition has it (HyperEVM and Monad testnets do, lib/chains), in
 * aggregate calls of up to 16 KB calldata; anvil has none, so it falls back to parallel eth_calls there.
 * Results are in call order; any failure throws.
 */
export async function readMany(client: PublicClient, calls: readonly Call[]): Promise<unknown[]> {
  if (calls.length === 0) return [];
  if (client.chain?.contracts?.multicall3) {
    return client.multicall({ contracts: calls as never, allowFailure: false, batchSize: 16_384 }) as Promise<unknown[]>;
  }
  return Promise.all(calls.map((c) => client.readContract(c as never)));
}

/** Same, but failed calls come back as `undefined` instead of failing the whole batch. */
export async function readManySafe(client: PublicClient, calls: readonly Call[]): Promise<(unknown | undefined)[]> {
  if (calls.length === 0) return [];
  if (client.chain?.contracts?.multicall3) {
    const r = (await client.multicall({ contracts: calls as never, allowFailure: true, batchSize: 16_384 })) as { status: string; result?: unknown }[];
    return r.map((x) => (x.status === "success" ? x.result : undefined));
  }
  return Promise.all(calls.map((c) => client.readContract(c as never).catch(() => undefined)));
}
