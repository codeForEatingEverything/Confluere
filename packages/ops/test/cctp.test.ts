import { describe, expect, it } from "vitest";
import { awaitAttestation, cctpChain, relay, resumeCommand, usdcUnits } from "../src/cctp";

const BURN = `0x${"ab".repeat(32)}` as const;
// anvil key 0: test-only
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Fake Iris and clock: `pending` polls answer "pending" before the attestation completes (Infinity = never). */
function iris(pending: number) {
  let t = 0;
  let polls = 0;
  return {
    polls: () => polls,
    opts: {
      pollMs: 20_000,
      timeoutMs: 30 * 60_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      fetch: async () => {
        polls++;
        const status = polls > pending ? "complete" : "pending_confirmations";
        return { ok: true, json: async () => ({ messages: [{ status, message: "0x01", attestation: "0x02" }] }) };
      },
    },
  };
}

describe("cctp", () => {
  it("rejects unknown chain names before anything is sent", () => {
    expect(cctpChain(undefined, "monad")).toBe("monad");
    expect(cctpChain("hyperevm", "monad")).toBe("hyperevm");
    expect(() => cctpChain("hyperliquid", "monad")).toThrow(/unknown chain hyperliquid/);
    for (const inherited of ["toString", "constructor", "__proto__", "hasOwnProperty"]) expect(() => cctpChain(inherited, "monad")).toThrow(/unknown chain/);
  });
  it("parses USDC amounts and rejects non-positive ones", () => {
    expect(usdcUnits("10.5")).toBe(10_500_000n);
    expect(() => usdcUnits("abc")).toThrow();
    expect(() => usdcUnits("0")).toThrow();
  });
  it("returns the attestation once Iris reports it complete", async () => {
    const f = iris(3);
    const m = await awaitAttestation(19, BURN, f.opts);
    expect(m.attestation).toBe("0x02");
    expect(f.polls()).toBe(4);
  });
  it("gives up after the timeout instead of polling forever", async () => {
    const f = iris(Infinity);
    await expect(awaitAttestation(19, BURN, f.opts)).rejects.toThrow(/no attestation .* after 30 min/);
    expect(f.polls()).toBe(91); // at 0 s and every 20 s through the 30-minute mark
  });
  it("resume refuses a malformed burn hash and names the command to rerun", async () => {
    await expect(relay(KEY, "0x1234", "hyperevm", "monad")).rejects.toThrow(/not a transaction hash/);
    expect(resumeCommand(BURN, "hyperevm", "monad")).toBe(`pnpm --filter @confluere/ops cctp-resume ${BURN} hyperevm monad`);
  });
});
