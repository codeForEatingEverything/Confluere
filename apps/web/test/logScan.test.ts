/** Server log scanner: chunking, contiguous progress, per-chunk fallback to a narrower source, newest-first order. */
import { describe, expect, it } from "vitest";
import { chunks, headOf, pool, scanLogs, type LogSource, type Rpc } from "../src/lib/server/logScan";

const A: LogSource = { url: "https://a.example", range: 1000, concurrency: 3 };
const B: LogSource = { url: "https://b.example", range: 100, concurrency: 2 };

type Call = { url: string; from: number; to: number };

function fakeRpc(opts: { failOn?: (c: Call) => string | undefined; logsAt?: number[] } = {}) {
  const calls: Call[] = [];
  const rpc: Rpc = async (url, method, params) => {
    if (method === "eth_blockNumber") return "0x7d0";
    const f = params[0] as { fromBlock: string; toBlock: string };
    const c = { url, from: Number(f.fromBlock), to: Number(f.toBlock) };
    calls.push(c);
    const err = opts.failOn?.(c);
    if (err) throw new Error(err);
    return (opts.logsAt ?? []).filter((b) => b >= c.from && b <= c.to).map((b) => ({ blockNumber: `0x${b.toString(16)}`, logIndex: "0x0", topics: [], data: "0x" }));
  };
  return { rpc, calls };
}

describe("chunks", () => {
  it("splits an inclusive range into pieces of at most `size` blocks", () => {
    expect(chunks(10n, 2509n, 1000)).toEqual([
      [10n, 1009n],
      [1010n, 2009n],
      [2010n, 2509n],
    ]);
    expect(chunks(5n, 5n, 100)).toEqual([[5n, 5n]]);
    expect(chunks(6n, 5n, 100)).toEqual([]);
  });
});

describe("pool", () => {
  it("never runs more than n at once and stops at the first failure", async () => {
    let live = 0;
    let peak = 0;
    const seen: number[] = [];
    await expect(
      pool([1, 2, 3, 4, 5, 6], 2, async (x) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        seen.push(x);
        if (x === 3) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(peak).toBe(2);
    expect(seen).not.toContain(6);
  });
});

describe("scanLogs", () => {
  it("delivers every log once and reports contiguous progress up to the end", async () => {
    const { rpc } = fakeRpc({ logsAt: [5, 1500, 2999] });
    const got: number[] = [];
    const progress: bigint[] = [];
    await scanLogs({ from: 0n, to: 2999n, sources: [A], rpc, filter: { address: "0x00" }, onLogs: (l) => got.push(...l.map((x) => Number(x.blockNumber))), onProgress: (p) => progress.push(p) });
    expect(got.sort((a, b) => a - b)).toEqual([5, 1500, 2999]);
    expect(progress.at(-1)).toBe(2999n);
    // progress never goes backwards
    expect([...progress].sort((a, b) => (a < b ? -1 : 1))).toEqual(progress);
  });

  it("splits a chunk the first source refuses into the next source's range", async () => {
    const { rpc, calls } = fakeRpc({ failOn: (c) => (c.url === A.url && c.from === 1000 ? "block range too large" : undefined), logsAt: [1234] });
    const got: number[] = [];
    await scanLogs({ from: 0n, to: 1999n, sources: [A, B], rpc, backoffMs: 1, filter: { address: "0x00" }, onLogs: (l) => got.push(...l.map((x) => Number(x.blockNumber))) });
    expect(got).toEqual([1234]);
    const viaB = calls.filter((c) => c.url === B.url);
    expect(viaB).toHaveLength(10); // 1000..1999 in 100-block pieces
    expect(viaB.every((c) => c.to - c.from + 1 <= 100)).toBe(true);
    // a range error is not retried on the same source
    expect(calls.filter((c) => c.url === A.url && c.from === 1000)).toHaveLength(1);
  });

  it("retries a transient failure once before falling back", async () => {
    let n = 0;
    const { rpc, calls } = fakeRpc({ failOn: (c) => (c.url === A.url && n++ === 0 ? "HTTP 429" : undefined) });
    await scanLogs({ from: 0n, to: 999n, sources: [A, B], rpc, backoffMs: 1, filter: { address: "0x00" }, onLogs: () => {} });
    expect(calls.filter((c) => c.url === A.url)).toHaveLength(2);
    expect(calls.filter((c) => c.url === B.url)).toHaveLength(0);
  });

  it("rejects when no source can serve a chunk, keeping the progress made before it", async () => {
    const { rpc } = fakeRpc({ failOn: (c) => (c.from >= 1000 ? "down" : undefined) });
    const progress: bigint[] = [];
    await expect(
      scanLogs({ from: 0n, to: 2999n, sources: [{ ...A, concurrency: 1 }], rpc, backoffMs: 1, filter: { address: "0x00" }, onLogs: () => {}, onProgress: (p) => progress.push(p) }),
    ).rejects.toThrow("down");
    expect(progress).toEqual([999n]);
  });

  it("newest-first reads recent chunks first and still reports progress only once the oldest is in", async () => {
    const { rpc, calls } = fakeRpc();
    const progress: bigint[] = [];
    await scanLogs({ from: 0n, to: 2999n, sources: [{ ...A, concurrency: 1 }], rpc, filter: { address: "0x00" }, newestFirst: true, onLogs: () => {}, onProgress: (p) => progress.push(p) });
    expect(calls.map((c) => c.from)).toEqual([2000, 1000, 0]);
    expect(progress).toEqual([2999n]);
  });
});

describe("headOf", () => {
  it("falls through to the next source when the first is down", async () => {
    const rpc: Rpc = async (url) => {
      if (url === A.url) throw new Error("down");
      return "0x10";
    };
    expect(await headOf([A, B], rpc)).toBe(16n);
  });
});
