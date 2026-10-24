/** Faucet mint probe: a WETH9-style fallback must not pass for a public mint (audit #3). */
import { describe, expect, it, vi } from "vitest";
import { NATIVE_FAUCET, getTokenStep, obtainInfo, probeMintable, stakeStep } from "../src/lib/tokens";

const ME = "0x00000000000000000000000000000000000000e1" as const;
const revert = () => Promise.reject(new Error("execution reverted"));
const client = (o: { call: () => Promise<unknown>; simulate: () => Promise<unknown> }) => ({ call: vi.fn(o.call), simulateContract: vi.fn(o.simulate) }) as any;

describe("probeMintable", () => {
  it("a mock ERC-20 with a public mint is mintable", async () => {
    const c = client({ call: revert, simulate: async () => ({ result: undefined }) });
    expect(await probeMintable(c, "0x00000000000000000000000000000000000000a1", ME, 31337)).toBe(true);
  });

  it("a contract whose fallback swallows any call (WHYPE / WMON) is not mintable", async () => {
    // mint() 'succeeds' with empty return data because the fallback runs deposit() with 0 value
    const c = client({ call: async () => ({ data: undefined }), simulate: async () => ({ result: undefined }) });
    expect(await probeMintable(c, "0x00000000000000000000000000000000000000a4", ME, 31337)).toBe(false);
  });

  it("known real tokens are never probed", async () => {
    const c = client({ call: revert, simulate: async () => ({ result: undefined }) });
    expect(await probeMintable(c, "0x5555555555555555555555555555555555555555", ME, 998)).toBe(false);
    expect(await probeMintable(c, "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541", ME, 10143)).toBe(false);
    expect(c.call).not.toHaveBeenCalled();
    expect(c.simulateContract).not.toHaveBeenCalled();
  });

  it("a token whose mint reverts is not mintable", async () => {
    const c = client({ call: revert, simulate: revert });
    expect(await probeMintable(c, "0x00000000000000000000000000000000000000b2", ME, 31337)).toBe(false);
  });
});

describe("Sepolia tokens", () => {
  const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as const;
  const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
  const WSTETH = "0xB82381A3fBD3FaFA77B3a7bE693342618240067b" as const;
  it("WETH wraps ETH, USDC comes from Circle's faucet, wstETH is never offered outside the Loop flow", () => {
    expect(getTokenStep(11155111, { address: WETH, symbol: "WETH" })).toEqual({ kind: "wrap", token: WETH, native: "ETH", label: "Wrap ETH" });
    expect(getTokenStep(11155111, { address: USDC, symbol: "USDC" })).toMatchObject({ kind: "faucet", href: "https://faucet.circle.com" });
    expect(obtainInfo(WSTETH, "wstETH", 11155111)).toBeUndefined();
    expect(obtainInfo(WSTETH, "wstETH", 11155111, { allowStake: true })).toMatchObject({ kind: "stake", provider: "Lido" });
  });
  it("the Loop flow names Lido for wstETH and FastLane for shMON", () => {
    expect(stakeStep(11155111, WSTETH)?.provider).toBe("Lido");
    // Lido has no Sepolia staking site: no link, the step itself says where to send the ETH
    expect(stakeStep(11155111, WSTETH)?.href).toBeUndefined();
    expect(stakeStep(11155111, WSTETH)?.note).toMatch(/0xB82381A3fBD3FaFA77B3a7bE693342618240067b/);
    expect(stakeStep(10143, "0x282BdDFF5e58793AcAb65438b257Dbd15A8745C9")?.provider).toBe("FastLane");
  });
  it("known real tokens are never probed for a mint; Sepolia ETH has a faucet link", async () => {
    const c = client({ call: revert, simulate: async () => ({ result: undefined }) });
    expect(await probeMintable(c, WETH, ME, 11155111)).toBe(false);
    expect(c.simulateContract).not.toHaveBeenCalled();
    expect(NATIVE_FAUCET[11155111]).toMatch(/sepolia/);
  });
});
