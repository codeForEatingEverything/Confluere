/** Network status line: derived from the active chain's watched queries only. */
import { describe, expect, it } from "vitest";
import { networkStatusOf, retryDelay } from "../src/lib/network";

const q = (key: unknown[], s: Partial<{ status: string; fetchStatus: string; fetchFailureCount: number; dataUpdatedAt: number; errorUpdatedAt: number }>, observers = 1) => ({
  queryKey: key,
  state: { status: "success", fetchStatus: "idle", fetchFailureCount: 0, dataUpdatedAt: 1, errorUpdatedAt: 0, ...s },
  getObserversCount: () => observers,
}) as never;

describe("networkStatusOf", () => {
  it("ok when every watched query of the chain succeeded", () => {
    expect(networkStatusOf([q(["pools", 998], {}), q(["now", 998], { dataUpdatedAt: 5 })], 998, "HyperEVM testnet")).toMatchObject({ state: "ok", message: "", lastOk: 5 });
  });

  it("retrying while a query refetches after a failure", () => {
    const s = networkStatusOf([q(["pools", 998], { fetchStatus: "fetching", fetchFailureCount: 1 })], 998, "HyperEVM testnet");
    expect(s).toMatchObject({ state: "retrying", message: "Network busy, retrying…", failing: 1 });
  });

  it("down after retries are exhausted, naming the network", () => {
    const s = networkStatusOf([q(["pools", 10143], { status: "error", errorUpdatedAt: 9 })], 10143, "Monad testnet");
    expect(s.state).toBe("down");
    expect(s.message).toContain("Monad testnet");
  });

  it("ignores other chains and queries nobody watches", () => {
    const qs = [q(["pools", 10143], { status: "error" }), q(["pools", 998], { status: "error" }, 0)];
    expect(networkStatusOf(qs, 998, "HyperEVM testnet").state).toBe("ok");
  });

  it("loading on a first fetch", () => {
    expect(networkStatusOf([q(["pools", 998], { status: "pending", fetchStatus: "fetching", dataUpdatedAt: 0 })], 998, "x").state).toBe("loading");
  });
});

describe("retryDelay", () => {
  it("backs off 1 s, 2 s, 4 s, capped at 8 s", () => {
    expect([0, 1, 2, 3, 6].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 8000]);
  });
});
