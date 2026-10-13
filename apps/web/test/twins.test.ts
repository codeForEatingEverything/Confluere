/**
 * Native twins (lib/twins): on every list page each on-chain row touching the wrapped coin appears twice, once as the
 * native pairing (HYPE / USDC, pays in HYPE) and once as the wrapped one (WHYPE / USDC). Counted per page and network,
 * on live-shaped fixtures (the testnet deployments' tokens) and on the demo's sample set.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kind, Status, deployments, marketId } from "@confluere/sdk";
import { pairName, parsePay, payOf, poolTwins, shownToken, twinKey, vaultTwins } from "../src/lib/twins";
import { loopMarkets } from "../src/lib/loop";
import { exitDemo, setDemo } from "../src/lib/demo/mode";
import { indexPools, readCall, resetDemoNetworks } from "../src/lib/demo/chain";
import { deploymentOf, launchTokensOf } from "../src/lib/chains";

type P = { id: string; asset: string; quote: string; kind: Kind; bandBps: number; status: number; expiry: number };

const coinOf = (chainId: number) => (chainId === 998 ? "HYPE" : "MON");
const wrappedSym = (chainId: number) => (chainId === 998 ? "WHYPE" : "WMON");
const lstSym = (chainId: number) => (chainId === 998 ? "kHYPE" : "shMON");

function tokensOf(chainId: number) {
  const t = launchTokensOf(chainId);
  const m: Record<string, { address: string; symbol: string }> = {};
  if (t.native) m[t.native.toLowerCase()] = { address: t.native, symbol: wrappedSym(chainId) };
  if (t.usdc) m[t.usdc.toLowerCase()] = { address: t.usdc, symbol: "USDC" };
  if (t.lst) m[t.lst.toLowerCase()] = { address: t.lst, symbol: lstSym(chainId) };
  return m;
}

/** What each page lists, from on-chain rows (the page filters, before twinning). */
function pages(chainId: number, pools: P[], vaults: { address: string; quote: string }[]) {
  const now = Math.floor(Date.now() / 1000);
  const open = pools.filter((p) => p.status === Status.Open && p.expiry > now);
  const notClosed = pools.filter((p) => p.status !== Status.Closed);
  const markets = [...new Map(pools.map((p) => [marketId(p.asset as `0x${string}`, p.quote as `0x${string}`, p.kind), { id: marketId(p.asset as `0x${string}`, p.quote as `0x${string}`, p.kind), asset: p.asset, quote: p.quote }])).values()];
  return { Borrow: open, Loop: loopMarkets(open, chainId), Markets: notClosed, LP: markets, Earn: vaults };
}

const touches = (w: string, ...a: string[]) => a.some((x) => x.toLowerCase() === w.toLowerCase());

function check(chainId: number, pools: P[], vaults: { address: string; quote: string }[], want: Record<string, string[]>) {
  const w = launchTokensOf(chainId).native!;
  const tokens = tokensOf(chainId);
  const coin = coinOf(chainId);
  const pg = pages(chainId, pools, vaults);
  const counts: Record<string, number> = {};
  for (const [page, rows] of Object.entries(pg)) {
    const isVault = page === "Earn";
    const tw = isVault ? vaultTwins(rows as { address: string; quote: string }[], w) : poolTwins(rows as { asset: string; quote: string }[], w);
    const onChain = rows.length;
    const touching = isVault ? (rows as { quote: string }[]).filter((r) => touches(w, r.quote)).length : (rows as { asset: string; quote: string }[]).filter((r) => touches(w, r.asset, r.quote)).length;
    // exact: every on-chain row once, plus one twin for each row touching the wrapped coin
    expect(tw, `${page} on ${chainId}`).toHaveLength(onChain + touching);
    expect(tw.filter((r) => r.via === "native")).toHaveLength(touching);
    // stable, unique keys (on-chain id + pairing)
    const keys = tw.map((r) => twinKey(((r as { id?: string; address?: string }).id ?? (r as { address?: string }).address)!, r.via));
    expect(new Set(keys).size).toBe(keys.length);
    // each twin sits right before its on-chain row and opens with the coin preset; the on-chain row with the wrapped one
    tw.forEach((r, i) => {
      if (r.via === "native") {
        expect(tw[i + 1]!.via).toBe("wrapped");
        expect(payOf(r)).toBe("native");
        expect(payOf(tw[i + 1])).toBe("wrapped");
      }
    });
    if (!isVault) {
      const names = new Set((tw as { asset: string; quote: string; via: "native" | "wrapped" }[]).map((r) => pairName(tokens, r, w, coin)));
      for (const n of want[page] ?? []) expect(names, `${page} on ${chainId} lists ${n}`).toContain(n);
    }
    counts[page] = tw.length;
  }
  return counts;
}

describe("the helper", () => {
  const W = "0x5555555555555555555555555555555555555555";
  const U = "0x00000000000000000000000000000000000000aa";
  it("twins rows touching the wrapped coin, native first, and names them", () => {
    const rows = [
      { id: "a", asset: W, quote: U },
      { id: "b", asset: U, quote: "0x00000000000000000000000000000000000000bb" },
    ];
    const t = poolTwins(rows, W);
    expect(t.map((r) => `${r.id}:${r.via}:${r.twin}`)).toEqual(["a:native:true", "a:wrapped:true", "b:wrapped:false"]);
    expect(payOf(t[2])).toBeUndefined();
    const tokens = { [W.toLowerCase()]: { address: W, symbol: "WHYPE" }, [U]: { address: U, symbol: "USDC" } };
    expect(pairName(tokens, t[0]!, W, "HYPE")).toBe("HYPE / USDC");
    expect(pairName(tokens, t[1]!, W, "HYPE")).toBe("WHYPE / USDC");
    expect(shownToken(tokens[W.toLowerCase()], W, "native", W, "HYPE")).toEqual({ address: "0x0000000000000000000000000000000000000000", symbol: "HYPE", native: true });
    expect(shownToken(tokens[W.toLowerCase()], W, "wrapped", W, "HYPE").symbol).toBe("WHYPE");
    expect(poolTwins(rows, undefined)).toHaveLength(2);
    expect(parsePay("native")).toBe("native");
    expect(parsePay("x")).toBeUndefined();
  });
});

describe("live testnets (fixtures shaped like the deployments)", () => {
  const future = Math.floor(Date.now() / 1000) + 86_400;
  const pool = (i: number, asset: string, quote: string, kind = Kind.American, bandBps = 800): P => ({ id: `0x${i.toString(16).padStart(64, "0")}`, asset, quote, kind, bandBps, status: Status.Open, expiry: future + i });

  it("HyperEVM: HYPE / USDC + WHYPE / USDC and USDC / HYPE + USDC / WHYPE on every page", () => {
    const { native: W, usdc: U } = launchTokensOf(998);
    // three WHYPE / USDC pools (both styles) and two USDC / WHYPE pools
    const pools = [pool(1, W!, U!), pool(2, W!, U!), pool(3, W!, U!, Kind.European), pool(4, U!, W!), pool(5, U!, W!)];
    const v = deployments[998]!.vaults!;
    const vaults = [
      { address: v.usdLow, quote: U! },
      { address: v.usdHigh!, quote: U! },
      ...(v.nativeLend ? [{ address: v.nativeLend, quote: W! }] : []),
    ];
    const all = ["HYPE / USDC", "WHYPE / USDC", "USDC / HYPE", "USDC / WHYPE"];
    const c = check(998, pools, vaults, { Borrow: all, Markets: all, LP: all, Loop: ["HYPE / USDC", "WHYPE / USDC"] });
    expect(c).toEqual({ Borrow: 10, Loop: 6, Markets: 10, LP: 6, Earn: vaults.length + (v.nativeLend ? 1 : 0) });
  });

  it("Monad: MON / USDC + WMON / USDC and shMON / MON + shMON / WMON on every page", () => {
    const { native: W, usdc: U, lst: L } = launchTokensOf(10143);
    const pools = [pool(1, W!, U!), pool(2, W!, U!, Kind.European), pool(3, L!, W!, Kind.American, 150)];
    const v = deployments[10143]!.vaults!;
    const vaults = [{ address: v.usdLow, quote: U! }, ...(v.usdHigh ? [{ address: v.usdHigh, quote: U! }] : []), ...(v.pegged ? [{ address: v.pegged, quote: W! }] : [])];
    const all = ["MON / USDC", "WMON / USDC", "shMON / MON", "shMON / WMON"];
    const c = check(10143, pools, vaults, { Borrow: all, Markets: all, LP: all, Loop: all });
    expect(c).toEqual({ Borrow: 6, Loop: 6, Markets: 6, LP: 6, Earn: vaults.length + (v.pegged ? 1 : 0) });
  });
});

describe("the demo's sample set", () => {
  beforeEach(() => {
    resetDemoNetworks();
    setDemo(true);
  });
  afterEach(() => exitDemo());

  function demo(chainId: number) {
    const d = deploymentOf(chainId)!;
    const pools = (indexPools(chainId).pools as unknown as P[]).map((p) => ({ ...p, status: (readCall(chainId, { address: d.confluere, functionName: "pool", args: [p.id] }) as { status: number }).status }));
    const v = d.vaults!;
    const { native: W, usdc: U } = launchTokensOf(chainId);
    const vaults = [
      { address: v.usdLow, quote: U! },
      { address: v.usdHigh!, quote: U! },
      { address: v.pegged!, quote: W! },
      ...(v.nativeLend ? [{ address: v.nativeLend, quote: W! }] : []),
    ];
    return { pools, vaults };
  }

  it("HyperEVM demo: also kHYPE / HYPE + kHYPE / WHYPE, and kHYPE / USDC once (no wrapped coin in it)", () => {
    const { pools, vaults } = demo(998);
    const all = ["HYPE / USDC", "WHYPE / USDC", "USDC / HYPE", "USDC / WHYPE", "kHYPE / HYPE", "kHYPE / WHYPE", "kHYPE / USDC"];
    const c = check(998, pools, vaults, { Borrow: all, Markets: all, LP: all, Loop: ["HYPE / USDC", "WHYPE / USDC", "kHYPE / HYPE", "kHYPE / WHYPE"] });
    // 45 open pools, 12 of them kHYPE / USDC; 47 pools in 7 markets, 2 of them kHYPE / USDC; 4 vaults, 2 in WHYPE
    expect(c).toEqual({ Borrow: 45 + 33, Loop: 25 * 2, Markets: 46 + 34, LP: 7 + 5, Earn: 6 });
  });

  it("Monad demo: MON / USDC + WMON / USDC, shMON / MON + shMON / WMON, and shMON / USDC once", () => {
    const { pools, vaults } = demo(10143);
    const all = ["MON / USDC", "WMON / USDC", "shMON / MON", "shMON / WMON", "shMON / USDC"];
    const c = check(10143, pools, vaults, { Borrow: all, Markets: all, LP: all, Loop: ["MON / USDC", "WMON / USDC", "shMON / MON", "shMON / WMON"] });
    expect(c).toEqual({ Borrow: 40 + 28, Loop: 28 * 2, Markets: 41 + 29, LP: 6 + 4, Earn: 4 });
  });
});
