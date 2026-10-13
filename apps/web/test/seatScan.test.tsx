// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Status } from "@confluere/sdk";
import { pid, row } from "./fixtures";

// The grid read fails; the block time and logs would answer.
const client = {
  readContract: vi.fn(async () => {
    throw new Error("rpc down");
  }),
  getBlock: vi.fn(async () => ({ number: 0n, timestamp: 0n })),
  getBlockNumber: vi.fn(async () => 1000n),
  getLogs: vi.fn(async () => []),
};
vi.mock("wagmi", () => ({ usePublicClient: () => client }));
vi.mock("../src/lib/config", () => ({
  CHAIN_ID: 31337,
  deployment: { confluere: `0x${"11".repeat(20)}`, seatRegistry: `0x${"22".repeat(20)}`, deployBlock: 1 },
}));

const { useSeatOrderKeys } = await import("../src/lib/data");
const { seatLockState } = await import("../src/lib/window");

describe("seat-lock scan when the grid read fails (#9)", () => {
  it("reports an error, so live orders count as not locked instead of 'checking seat lock…' forever", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const NOW = Math.floor(Date.now() / 1000);
    const p = row(pid("aa"), { status: Status.Open, expiry: NOW + 86_400, settleCount: 3 }) as any;
    const { result } = renderHook(() => useSeatOrderKeys([p]), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getLogs).not.toHaveBeenCalled();
    expect(seatLockState(result.current, p, { id: 2n, deadline: 10 }, NOW, true)).toBe(false);
  });
});
