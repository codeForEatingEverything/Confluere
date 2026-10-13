import { describe, expect, it } from "vitest";
import { Kind, Status, marketId } from "@confluere/sdk";
import { groupMarkets, isPegged, pastExpiries, poolsOf } from "../src/lib/markets";
import { LST, NAT, NOW, USDC, WETH, pid, row } from "./fixtures";

describe("groupMarkets", () => {
  const pools = [
    row(pid("01"), { strike: 3100_000000n }),
    row(pid("02"), { strike: 3000_000000n }),
    row(pid("03"), { expiry: NOW + 86_400, strike: 3000_000000n }),
    row(pid("04"), { kind: Kind.European }),
    row(pid("05"), { asset: LST, quote: NAT, bandBps: 150, graduated: false, status: Status.Closed }),
  ] as any[];

  it("groups by (asset, quote, kind) with the on-chain market id", () => {
    const ms = groupMarkets(pools);
    expect(ms).toHaveLength(3);
    const am = ms.find((m) => m.asset === WETH && m.kind === Kind.American)!;
    expect(am.id).toBe(marketId(WETH, USDC, Kind.American));
    expect(am.pools.map((p) => p.id)).toEqual([pid("03"), pid("02"), pid("01")]); // expiry, then strike
  });

  it("sorts graduated and busier markets first", () => {
    const ms = groupMarkets(pools);
    expect(ms[ms.length - 1]!.asset).toBe(LST);
    expect(isPegged(ms[ms.length - 1]!)).toBe(true);
  });

  it("lays out expiry x strike", () => {
    const am = groupMarkets(pools)[0]!;
    const g = poolsOf(am);
    expect(g.expiries).toEqual([NOW + 86_400, NOW + 3 * 86_400]);
    expect(g.strikes).toEqual([3000_000000n, 3100_000000n]);
    expect(g.cell(NOW + 86_400, 3100_000000n)).toBeUndefined();
  });

  it("past grid expiries for graduation, newest first", () => {
    expect(pastExpiries(1000, 100, 1450)).toEqual([1400, 1300, 1200, 1100]);
    expect(pastExpiries(1000, 100, 1150)).toEqual([1100, 1000]);
  });
});

describe("latestMaturities: three maturities per pair", () => {
  const A = "0xa", B = "0xb", C = "0xc";
  const mk = (asset: string, quote: string, expiry: number, live: boolean) => ({ asset, quote, expiry, live });
  const live = (p: { live: boolean }) => p.live;
  it("more than three live: the soonest three, every pool of each kept", async () => {
    const { latestMaturities } = await import("../src/lib/markets");
    const ps = [1, 2, 3, 4, 5].flatMap((e) => [mk(A, B, e, true), mk(A, B, e, true)]);
    expect([...new Set(latestMaturities(ps, live).map((p) => p.expiry))]).toEqual([1, 2, 3]);
    expect(latestMaturities(ps, live)).toHaveLength(6);
  });
  it("fewer than three live: filled with the latest matured; each pair counted on its own", async () => {
    const { latestMaturities } = await import("../src/lib/markets");
    const ps = [mk(A, B, 1, false), mk(A, B, 2, false), mk(A, B, 3, false), mk(A, B, 9, true), mk(A, C, 1, false)];
    expect(latestMaturities(ps, live).filter((p) => p.quote === B).map((p) => p.expiry).sort()).toEqual([2, 3, 9]);
    expect(latestMaturities(ps, live).filter((p) => p.quote === C)).toHaveLength(1);
  });
});
