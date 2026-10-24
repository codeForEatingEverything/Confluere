import { BaseError, type Address, type Hex } from "viem";
import { Status, type Deployment } from "@confluere/sdk";
import type { Clients } from "../src/chain.js";

export const CORE = "0x00000000000000000000000000000000000000c0" as Address;
export const REG = "0x00000000000000000000000000000000000000e0" as Address;
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const ZERO32 = `0x${"00".repeat(32)}` as Hex;

export const deployment = {
  chainId: 31337,
  confluere: CORE,
  vaultFactory: "0x00000000000000000000000000000000000000f0",
  seatRegistry: REG,
  gridAnchor: 0,
  gridPeriod: 3600,
  batchInterval: 120,
  deployBlock: 0,
} as unknown as Deployment;

export type MockPool = {
  asset: Address;
  quote: Address;
  kind: number;
  status: Status;
  expiry: number;
  windowEnd?: bigint;
  settleCount?: number;
  nextBatchAt: number;
  /** resting orders per side, head first */
  book?: Partial<Record<number, { id: bigint; deadline: number; rolloverSource?: Hex; autoSellSource?: Hex }[]>>;
};

export type MockVault = {
  targetExpiry: bigint;
  pendingDepositAssets: bigint;
  pendingRedeemShares: bigint;
  investable?: bigint;
  assets?: Address[];
  targetPool?: Hex;
};

export type Call = { method: string; fn?: string; args?: readonly unknown[]; address?: Address };

/** A fake chain: counts every RPC request and answers the views the keeper reads from in-memory state. */
export function mockChain(state: {
  pools: Record<Hex, MockPool>;
  vaults?: Record<Address, MockVault>;
  graduated?: Set<Hex>;
  expiryWindowEnd?: Record<number, bigint>;
  /** seat per market id: holder and last quoted base batch */
  seats?: Record<Hex, { holder: Address; lastQuoted: number }>;
  /** core.marketFees and SeatRegistry.feesSplit per market id */
  marketFees?: Record<Hex, bigint>;
  feesSplit?: Record<Hex, bigint>;
  /** simulateContract succeeds only for these function names (others revert like "nothing to do") */
  passes?: Set<string>;
  /** read or simulate calls that fail like a rate-limited RPC */
  failing?: (c: Call) => boolean;
  now: number;
  block: bigint;
}) {
  const calls: Call[] = [];
  const record = (c: Call) => {
    calls.push(c);
    if (state.failing?.(c)) throw new Error("HTTP 429 rate limited");
  };
  const orderOf = (pid: Hex, id: bigint) => {
    for (const [side, list] of Object.entries(state.pools[pid]?.book ?? {})) {
      const i = list!.findIndex((o) => o.id === id);
      if (i >= 0) return { side: Number(side), o: list![i]!, next: list![i + 1]?.id ?? 0n };
    }
    return undefined;
  };
  const read = (fn: string, args: readonly unknown[], address: Address): unknown => {
    if (address !== CORE && address !== REG) {
      const v = state.vaults?.[address];
      if (!v) throw new Error(`no vault ${address}`);
      if (fn === "investable") return v.investable ?? 0n;
      if (fn === "assets") return v.assets ?? [];
      if (fn === "targetPool") return v.targetPool ?? ZERO32;
      return v[fn as keyof MockVault];
    }
    const pid = args[0] as Hex;
    const p = state.pools[pid];
    switch (fn) {
      case "pool":
        return {
          key: { asset: p?.asset ?? ZERO, quote: p?.quote ?? ZERO, expiry: BigInt(p?.expiry ?? 0), strike: 1n, kind: p?.kind ?? 0, bandBps: 800, cadence: 0 },
          status: p?.status ?? Status.None,
          batchInterval: 0,
          windowEnd: p?.windowEnd ?? 0n,
          pausedUntil: 0n,
          settleCount: p?.settleCount ?? 0,
        };
      case "nextBatchAt":
        return BigInt(p!.nextBatchAt);
      case "bookHead": {
        const list = p?.book?.[args[1] as number] ?? [];
        return [list[0]?.id ?? 0n, list.length];
      }
      case "order": {
        const f = orderOf(pid, args[1] as bigint);
        if (!f) return [ZERO, 0, 0, 0n, 0n, 0n, 0, 0n];
        const flags = f.o.rolloverSource ? 1 : f.o.autoSellSource ? 4 : 0;
        return ["0x00000000000000000000000000000000000000aa", f.side, flags, 1n, 1n, 1n, f.o.deadline, f.next];
      }
      case "linkedPool":
        return orderOf(pid, args[1] as bigint)?.o.rolloverSource ?? orderOf(pid, args[1] as bigint)?.o.autoSellSource ?? ZERO32;
      case "expiryWindowEnd":
        return state.expiryWindowEnd?.[Number(args[0])] ?? 0n;
      case "graduated":
        return state.graduated?.has(args[0] as Hex) ?? false;
      case "seats": {
        const st = state.seats?.[args[0] as Hex];
        return [st?.holder ?? ZERO, 0n, 0n, 0n, 0n, 0n, BigInt(st?.lastQuoted ?? 0)];
      }
      case "marketFees":
        return state.marketFees?.[args[0] as Hex] ?? 0n;
      case "feesSplit":
        return state.feesSplit?.[args[0] as Hex] ?? 0n;
    }
    throw new Error(`unmocked read ${fn}`);
  };
  const c = {
    pub: {
      getBlockNumber: async () => {
        record({ method: "getBlockNumber" });
        return state.block;
      },
      getLogs: async () => {
        record({ method: "getLogs" });
        return [];
      },
      getBlock: async () => {
        record({ method: "getBlock" });
        return { timestamp: BigInt(state.now), number: state.block };
      },
      readContract: async (r: { functionName: string; args?: readonly unknown[]; address: Address }) => {
        const call = { method: "read", fn: r.functionName, args: r.args, address: r.address };
        record(call);
        return read(r.functionName, r.args ?? [], r.address);
      },
      simulateContract: async (r: { functionName: string; args?: readonly unknown[]; address: Address }) => {
        record({ method: "simulate", fn: r.functionName, args: r.args, address: r.address });
        if (!state.passes?.has(r.functionName)) throw new BaseError("execution reverted");
        return { request: r };
      },
      waitForTransactionReceipt: async () => {
        record({ method: "receipt" });
        return { status: "success", gasUsed: 1n };
      },
    },
    wallet: {
      writeContract: async (r: { functionName: string; args?: readonly unknown[]; address: Address }) => {
        record({ method: "write", fn: r.functionName, args: r.args, address: r.address });
        return "0x01";
      },
    },
    account: { address: "0x00000000000000000000000000000000000000bb" },
  } as unknown as Clients;
  return { c, calls };
}
