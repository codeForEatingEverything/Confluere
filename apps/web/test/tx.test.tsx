// @vitest-environment jsdom
/** useTx state machine (FRONTEND_DESIGN §5.4 #3): a wallet rejection resolves {ok:false}, never rejects. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult, parseAbi } from "viem";
import { confluereAbi } from "@confluere/sdk";
import type { ReactNode } from "react";

const m = vi.hoisted(() => ({
  simulate: vi.fn(),
  write: vi.fn(),
  receipt: vi.fn(),
  switch: vi.fn(),
  chainId: 31337,
}));

vi.mock("wagmi", () => ({
  useConnection: () => ({ address: "0x00000000000000000000000000000000000000e1", chainId: m.chainId, isConnected: true }),
  usePublicClient: () => ({ simulateContract: m.simulate, waitForTransactionReceipt: m.receipt, readContract: vi.fn() }),
  useWriteContract: () => ({ mutateAsync: m.write }),
  useSignMessage: () => ({ mutateAsync: vi.fn() }),
  useSwitchChain: () => ({ mutateAsync: m.switch, isPending: false }),
}));
vi.mock("@/lib/config", () => ({
  CHAIN_ID: 31337,
  chain: { id: 31337, name: "Anvil", blockExplorers: undefined },
  deployment: { confluere: "0x00000000000000000000000000000000000000d4" },
}));

import { useTx, type Write } from "../src/lib/tx";
import { classify, ERROR_COPY } from "../src/lib/txErrors";

const W: Write = { label: "Place order", address: "0x00000000000000000000000000000000000000d4", abi: confluereAbi, functionName: "placeOrder", args: [] };
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
const revert = (errorName: string) =>
  new ContractFunctionRevertedError({
    abi: confluereAbi as never,
    functionName: "placeOrder",
    data: encodeErrorResult({ abi: confluereAbi, errorName: errorName as never }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.chainId = 31337;
  vi.spyOn(console, "error").mockImplementation(() => {
    throw new Error("console.error must not be called");
  });
});

describe("useTx", () => {
  it("wallet rejection: run resolves {ok:false}, step is rejected, nothing thrown", async () => {
    m.simulate.mockResolvedValue({});
    m.write.mockRejectedValue(new UserRejectedRequestError(new Error("User rejected the request.")));
    const { result } = renderHook(() => useTx(), { wrapper });
    let r: { ok: boolean } | undefined;
    await act(async () => {
      r = await result.current.run([W]);
    });
    expect(r).toEqual({ ok: false });
    expect(result.current.steps[0]!.status).toBe("rejected");
    expect(result.current.lastError?.kind).toBe("rejected");
    expect(result.current.lastError?.title).toMatch(/cancelled in your wallet/);
    expect(result.current.busy).toBe(false);
  });

  it("decodes a simulated revert before the wallet opens", async () => {
    m.simulate.mockRejectedValue(revert("InvalidState"));
    const { result } = renderHook(() => useTx(), { wrapper });
    await act(async () => {
      await result.current.run([W]);
    });
    expect(m.write).not.toHaveBeenCalled();
    expect(result.current.steps[0]!.status).toBe("reverted");
    expect(result.current.lastError?.title).toBe(ERROR_COPY.InvalidState!.placeOrder);
  });

  it("runs steps in order and stops at the first failure", async () => {
    m.simulate.mockResolvedValue({});
    m.write.mockResolvedValueOnce("0xaa").mockRejectedValueOnce(new UserRejectedRequestError(new Error("no")));
    m.receipt.mockResolvedValue({ status: "success" });
    const { result } = renderHook(() => useTx(), { wrapper });
    await act(async () => {
      await result.current.run([{ ...W, label: "Approve USDC", simulate: false }, W, { ...W, label: "third" }]);
    });
    expect(result.current.steps.map((s) => s.status)).toEqual(["success", "rejected", "idle"]);
  });

  it("an on-chain revert is reported as reverted", async () => {
    m.simulate.mockResolvedValue({});
    m.write.mockResolvedValue("0xbb");
    m.receipt.mockResolvedValue({ status: "reverted" });
    const { result } = renderHook(() => useTx(), { wrapper });
    let r: { ok: boolean } | undefined;
    await act(async () => {
      r = await result.current.run([W]);
    });
    expect(r!.ok).toBe(false);
    expect(result.current.steps[0]!.status).toBe("reverted");
    expect(result.current.lastError?.title).toMatch(/failed on-chain/);
  });

  it("InvalidHint: refreshes the hint and retries once", async () => {
    const extra = parseAbi(["error InvalidHint()"]);
    const hintErr = new ContractFunctionRevertedError({ abi: extra as never, functionName: "placeOrder", data: encodeErrorResult({ abi: extra, errorName: "InvalidHint" }) });
    m.simulate.mockRejectedValueOnce(hintErr).mockResolvedValueOnce({});
    m.write.mockResolvedValue("0xcc");
    m.receipt.mockResolvedValue({ status: "success" });
    const refresh = vi.fn(async () => W);
    const { result } = renderHook(() => useTx(), { wrapper });
    let r: { ok: boolean } | undefined;
    await act(async () => {
      r = await result.current.run([{ ...W, refresh }]);
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(r!.ok).toBe(true);
  });

  it("switches the wallet chain first; a rejected switch is neutral", async () => {
    m.chainId = 1;
    m.switch.mockRejectedValue(new UserRejectedRequestError(new Error("rejected")));
    const { result } = renderHook(() => useTx(), { wrapper });
    await act(async () => {
      await result.current.run([W]);
    });
    expect(m.write).not.toHaveBeenCalled();
    expect(result.current.lastError?.kind).toBe("rejected");
  });

  it("a failing prepare function never rejects", async () => {
    const { result } = renderHook(() => useTx(), { wrapper });
    let r: { ok: boolean } | undefined;
    await act(async () => {
      r = await result.current.run(async () => {
        throw new Error("rpc down");
      });
    });
    expect(r!.ok).toBe(false);
  });
});

describe("classify", () => {
  it("maps code 4001 to rejected and per-function copy", () => {
    expect(classify({ code: 4001, message: "nope" }, { fn: "x" }).kind).toBe("rejected");
    expect(classify(revert("BookFull"), { fn: "bid" }).title).toMatch(/Too many orders are waiting/);
    expect(classify(revert("InvalidState"), { fn: "repay" }).title).toBe(ERROR_COPY.InvalidState!.repay);
  });

  it("an InvalidState cancel names the offer window as well as the slow-market cut-off", () => {
    const t = classify(revert("InvalidState"), { fn: "cancelOrder" }).title;
    expect(t).toMatch(/offers for unclaimed units can only be cancelled during the repayment window/);
    expect(t).toMatch(/last minutes before a round/);
  });

  it("a Locked cancel is a seat obligation order, not a rollover", () => {
    expect(classify(revert("Locked"), { fn: "cancelOrder" }).title).toBe("Seat quotes can't be cancelled while they can still fill.");
    expect(classify(revert("Locked"), { fn: "rollover" }).title).toMatch(/rolling over to the next maturity/);
  });
});
