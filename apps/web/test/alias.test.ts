/**
 * The wrapped coin is its own token: WHYPE and WMON keep their
 * contract symbols everywhere, and the network's coin (HYPE / MON, lib/native NATIVE) is a separate selector row next to
 * them. Icons: the wrapped coin uses the coin's logo (the UI adds a small "W" mark); market and LP names use the
 * on-chain tokens.
 */
import { afterEach, describe, expect, it } from "vitest";
import { deployments } from "@confluere/sdk";
import { onchainSymbol } from "../src/lib/data";
import { launchTokensOf } from "../src/lib/chains";
import { chainLogo, tokenLogo } from "../src/lib/logos";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { lpSymbol } from "../src/lib/lp";
import { selectorTokens } from "../src/lib/product";
import { NATIVE } from "../src/lib/native";
import { exitDemo, setDemo } from "../src/lib/demo/mode";

const ZERO = "0x0000000000000000000000000000000000000000";
const WHYPE = deployments[998]!.pools!.native;
const USDC_998 = deployments[998]!.pools!.usdc;
const WMON = deployments[10143]!.pools!.native;
const SHMON = deployments[10143]!.pools!.lst;
const USDC_MON = deployments[10143]!.pools!.usdc;

afterEach(() => exitDemo());

describe("the wrapped coin is its own token", () => {
  it("token symbols are the contract's own (no alias)", () => {
    expect(onchainSymbol({ symbol: "WHYPE" })).toBe("WHYPE");
    expect(onchainSymbol({ symbol: "WMON" })).toBe("WMON");
    expect(onchainSymbol({ symbol: "HYPE", onchainSymbol: "WHYPE" })).toBe("WHYPE");
    expect(onchainSymbol({ symbol: "USDC" })).toBe("USDC");
  });

  it("LP token names stay as on chain", () => {
    expect(lpSymbol({ symbol: "WHYPE" }, { symbol: "USDC" })).toBe("cLP-WHYPE-USDC");
    expect(lpSymbol("WHYPE", "USDC")).toBe("cLP-WHYPE-USDC");
  });

  it("one logo per coin: WHYPE uses the HYPE logo, WMON the MON logo; USDC and shMON their own", () => {
    expect(tokenLogo(998, WHYPE)).toBeTruthy();
    expect(tokenLogo(998, WHYPE)).toBe(tokenLogo(998, ZERO));
    expect(tokenLogo(10143, WMON)).toBe(tokenLogo(10143, ZERO));
    expect(tokenLogo(10143, SHMON)).not.toBe(tokenLogo(10143, ZERO));
    // Sepolia: WETH carries the ETH logo (plus the W mark in TokenIcon), wstETH and USDC their own; every file exists
    expect(tokenLogo(11155111, "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14")).toBe(tokenLogo(11155111, ZERO));
    expect(tokenLogo(11155111, "0xB82381A3fBD3FaFA77B3a7bE693342618240067b")).not.toBe(tokenLogo(11155111, ZERO));
    for (const a of [ZERO, "0xB82381A3fBD3FaFA77B3a7bE693342618240067b", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"]) {
      expect(existsSync(join(__dirname, "..", "public", tokenLogo(11155111, a)!))).toBe(true);
    }
    expect(existsSync(join(__dirname, "..", "public", chainLogo(11155111)!))).toBe(true);
    expect(tokenLogo(998, USDC_998)).not.toBe(tokenLogo(998, ZERO));
    expect(tokenLogo(998, undefined, "kHYPE")).toBeTruthy();
  });

  it("live HyperEVM lists no staked HYPE; the demo does", () => {
    expect(launchTokensOf(998).lst).toBeUndefined();
    setDemo(true);
    expect(launchTokensOf(998).lst).toBeTruthy();
    expect(tokenLogo(998, launchTokensOf(998).lst)).toMatch(/0xd3a0/);
  });
});

describe("selector rows come from the pools, with the coin next to its wrapped token", () => {
  const pair = (asset: string, quote: string, openPools = 1) => ({ asset: asset as `0x${string}`, quote: quote as `0x${string}`, openPools });

  it("HyperEVM live (WHYPE / USDC and USDC / WHYPE): HYPE, WHYPE and USDC on both sides", () => {
    const pairs = [pair(WHYPE, USDC_998, 6), pair(USDC_998, WHYPE, 2)];
    expect(selectorTokens(pairs, "asset", WHYPE)).toEqual([NATIVE, WHYPE, USDC_998]);
    expect(selectorTokens(pairs, "quote", WHYPE)).toEqual([USDC_998, NATIVE, WHYPE]);
    // the loan side of the USDC collateral: HYPE and WHYPE
    expect(selectorTokens(pairs.filter((p) => p.asset === USDC_998), "quote", WHYPE)).toEqual([NATIVE, WHYPE]);
  });

  it("Monad (WMON / USDC, shMON / WMON): MON next to WMON, shMON and USDC", () => {
    const pairs = [pair(WMON, USDC_MON, 4), pair(SHMON, WMON, 3)];
    expect(selectorTokens(pairs, "asset", WMON)).toEqual([NATIVE, WMON, SHMON]);
    expect(selectorTokens(pairs, "quote", WMON)).toEqual([USDC_MON, NATIVE, WMON]);
  });

  it("a token whose pools are all closed is not offered while others are open; with nothing open, every pair is", () => {
    const pairs = [pair(WHYPE, USDC_998, 3), pair(USDC_998, WHYPE, 0)];
    expect(selectorTokens(pairs, "asset", WHYPE)).toEqual([NATIVE, WHYPE]);
    const closed = [pair(WHYPE, USDC_998, 0)];
    expect(selectorTokens(closed, "asset", WHYPE)).toEqual([NATIVE, WHYPE]);
    expect(selectorTokens(closed, "quote", WHYPE)).toEqual([USDC_998]);
  });
});
