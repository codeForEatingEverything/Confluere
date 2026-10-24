// @vitest-environment jsdom
/** Active chain: the user's choice (URL / stored, default 998); the wallet is asked to follow; wallet-initiated changes are followed. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, renderHook } from "@testing-library/react";

const wallet = { isConnected: false, chainId: undefined as number | undefined };
const switchChain = vi.fn(async ({ chainId }: { chainId: number }) => {
  wallet.chainId = chainId;
});
const replaced: string[] = [];
vi.mock("next/navigation", () => ({ usePathname: () => "/earn", useSearchParams: () => new URLSearchParams(""), useRouter: () => ({ push: () => {}, replace: (u: string) => replaced.push(u), back: () => {} }) }));
vi.mock("wagmi", () => ({
  useConnection: () => wallet,
  useSwitchChain: () => ({ mutateAsync: switchChain, isPending: false }),
}));

const { ActiveChainProvider, setChainChoice, useActiveChain, useSwitchNetwork } = await import("../src/lib/activeChain");
const config = await import("../src/lib/config");
const { deployments } = await import("@confluere/sdk");

beforeEach(() => {
  wallet.isConnected = false;
  wallet.chainId = undefined;
  switchChain.mockClear();
  act(() => setChainChoice(998));
});

describe("useActiveChain", () => {
  it("defaults to HyperEVM testnet and follows the stored choice", () => {
    const { result } = renderHook(() => useActiveChain());
    expect(result.current.chainId).toBe(998);
    expect(result.current.deployment?.chainId).toBe(998);
    act(() => setChainChoice(10143));
    expect(result.current.chainId).toBe(10143);
    expect(localStorage.getItem("confluere.chain")).toBe("10143");
  });

  it("ignores unsupported choices", () => {
    act(() => setChainChoice(1));
    const { result } = renderHook(() => useActiveChain());
    expect(result.current.chainId).toBe(998);
  });

  it("inside the provider: a wallet that connects on the other served network is followed (no switch request), ?chain= follows", async () => {
    wallet.isConnected = true;
    wallet.chainId = 10143;
    let seen: number | undefined;
    const Probe = () => {
      seen = useActiveChain().chainId;
      return null;
    };
    await act(async () => {
      render(
        <ActiveChainProvider>
          <Probe />
        </ActiveChainProvider>,
      );
    });
    expect(seen).toBe(10143);
    expect(config.CHAIN_ID).toBe(10143);
    expect(switchChain).not.toHaveBeenCalled();
    expect(replaced.some((u) => u.includes("chain=monad"))).toBe(true);
  });

  it("a wallet that connects on Sepolia is followed like the other served networks, deployed or not", async () => {
    wallet.isConnected = true;
    wallet.chainId = 11155111;
    let v: ReturnType<typeof useActiveChain> | undefined;
    const Probe = () => {
      v = useActiveChain();
      return null;
    };
    await act(async () => {
      render(
        <ActiveChainProvider>
          <Probe />
        </ActiveChainProvider>,
      );
    });
    expect(v?.chainId).toBe(11155111);
    expect(v?.meta.native).toBe("ETH");
    expect(v?.walletOnOtherChain).toBe(false);
    expect(switchChain).not.toHaveBeenCalled();
    expect(replaced.some((u) => u.includes("chain=sepolia"))).toBe(true);
  });

  it("a wallet on a foreign chain leaves the app on the stored choice and flags it", () => {
    wallet.isConnected = true;
    wallet.chainId = 1;
    switchChain.mockRejectedValueOnce(new Error("User rejected"));
    let v: ReturnType<typeof useActiveChain> | undefined;
    const Probe = () => {
      v = useActiveChain();
      return null;
    };
    render(
      <ActiveChainProvider>
        <Probe />
      </ActiveChainProvider>,
    );
    expect(v?.chainId).toBe(998);
    expect(v?.walletOnOtherChain).toBe(true);
  });
});

describe("useSwitchNetwork", () => {
  it("disconnected: switches the read chain without touching a wallet", async () => {
    const { result } = renderHook(() => ({ sw: useSwitchNetwork(), active: useActiveChain() }));
    await act(async () => {
      expect(await result.current.sw.switchNetwork(10143)).toEqual({ ok: true });
    });
    expect(result.current.active.chainId).toBe(10143);
    await act(async () => {
      expect(await result.current.sw.switchNetwork(11155111)).toEqual({ ok: true });
    });
    expect(result.current.active.chainId).toBe(11155111);
    expect(result.current.active.deployment).toBe(deployments[11155111]); // undefined until deployments/sepolia.json exists
    expect(switchChain).not.toHaveBeenCalled();
  });

  it("connected: the app switches at once and asks the wallet; a rejection is reported, not thrown, and the app stays", async () => {
    wallet.isConnected = true;
    wallet.chainId = 998;
    const { result, rerender } = renderHook(() => useSwitchNetwork());
    await act(async () => {
      expect(await result.current.switchNetwork(10143)).toEqual({ ok: true });
    });
    expect(switchChain).toHaveBeenCalledWith({ chainId: 10143 });
    rerender(); // the wallet now reports 10143
    switchChain.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    let r: unknown;
    await act(async () => {
      r = await result.current.switchNetwork(998);
    });
    expect(r).toMatchObject({ ok: false, reason: "rejected" });
    expect(renderHook(() => useActiveChain()).result.current.chainId).toBe(998);
    expect(await result.current.switchNetwork(5)).toEqual({ ok: false, reason: "unsupported" });
  });
});
