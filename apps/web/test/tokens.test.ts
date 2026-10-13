/** Faucet mint probe: a WETH9-style fallback must not pass for a public mint (audit #3). */
import { describe, expect, it, vi } from "vitest";
import { probeMintable } from "../src/lib/tokens";

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
