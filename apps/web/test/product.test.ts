/** Product selectors: maturities and offers, best-pool pickers, amounts, pairs, vault roles, portfolio summary. */
import { describe, expect, it } from "vitest";
import { Kind, Status } from "@confluere/sdk";
import {
  borrowReceive,
  borrowRepay,
  claimEstimate,
  lendPayout,
  lendUnits,
  pairsOf,
  pickBorrowOffer,
  pickLendOffer,
  summarizePortfolio,
  termsFor,
  tierOf,
  unitsForQuote,
  vaultRole,
  vaultSharesValue,
} from "../src/lib/product";
import { E18, LST, NAT, NOW, USDC, WETH, pid, row } from "./fixtures";

const D = 86_400;
const pools = [
  // 3-day term: three strikes, the middle never traded
  row(pid("01"), { strike: 2800_000000n, lastClearingPrice: 2750_000000n }),
  row(pid("02"), { strike: 3000_000000n, lastClearingPrice: 2900_000000n }),
  row(pid("03"), { strike: 3200_000000n, lastClearingPrice: 0n }),
  row(pid("04"), { strike: 3400_000000n, lastClearingPrice: 3200_000000n, graduated: false }),
  // 10-day term
  row(pid("05"), { expiry: NOW + 10 * D, strike: 3000_000000n, lastClearingPrice: 2850_000000n }),
  // matured and closed: not listed unless asked
  row(pid("06"), { expiry: NOW - D, status: Status.Closed }),
  // another pair
  row(pid("07"), { asset: LST, quote: NAT, strike: 98n * 10n ** 16n, lastClearingPrice: 97n * 10n ** 16n }),
];

const q = { asset: WETH, quote: USDC, now: NOW, block: 1000n };

describe("termsFor", () => {
  it("groups the pair's open pools by maturity, soonest first, strikes ascending", () => {
    const t = termsFor(pools as never, q);
    expect(t.map((x) => x.expiry)).toEqual([NOW + 3 * D, NOW + 10 * D]);
    expect(t[0]!.offers.map((o) => o.strike)).toEqual([2800_000000n, 3000_000000n, 3200_000000n, 3400_000000n]);
    expect(t[0]!.offers.map((o) => o.tier)).toEqual(["low", "mid", "mid", "high"]);
    expect(t[0]!.secondsLeft).toBe(3 * D);
    expect(termsFor(pools as never, { ...q, includeClosed: true })).toHaveLength(3);
  });

  it("prices each offer: receive and repay per unit, fixed APR, gap to the reference", () => {
    const o = termsFor(pools as never, { ...q, ref: 3100, quoteDecimals: 6 })[0]!.offers[1]!;
    expect(o.receivePerUnit).toBe(2900_000000n);
    expect(o.repayPerUnit).toBe(3000_000000n);
    expect(o.apr).toBeCloseTo((100 / 2900) * (365 / 3), 6);
    expect(o.haircutVsRef).toBeCloseTo(1 - 2900 / 3100, 9);
    expect(o.repayVsRef).toBeCloseTo(3000 / 3100, 9);
    expect(o.discount).toBeCloseTo(100 / 3000, 9);
    expect(o.open).toBe(true);
    const unpriced = termsFor(pools as never, q)[0]!.offers[2]!;
    expect([unpriced.priced, unpriced.apr, unpriced.haircutVsRef]).toEqual([false, 0, undefined]);
  });

  it("a paused pool is not open", () => {
    const t = termsFor([row(pid("09"), { pausedUntil: 2000n })] as never, q);
    expect(t).toHaveLength(0);
  });
});

describe("tierOf", () => {
  it("one strike is mid, two are low and high", () => {
    expect(tierOf(0, 1)).toBe("mid");
    expect([tierOf(0, 2), tierOf(1, 2)]).toEqual(["low", "high"]);
  });
});

describe("pickBorrowOffer", () => {
  const t = termsFor(pools as never, q);
  it("low = lowest buy-back price among priced, graduated pools of the term", () => {
    expect(pickBorrowOffer(t, { tier: "low" })?.id).toBe(pid("01"));
  });
  it("high skips the ungraduated pool when a graduated one is priced", () => {
    expect(pickBorrowOffer(t, { tier: "high" })?.id).toBe(pid("02"));
  });
  it("mid picks the middle candidate; a missing maturity picks nothing", () => {
    expect(pickBorrowOffer(t, { tier: "mid" })?.id).toBe(pid("01"));
    expect(pickBorrowOffer(t, { expiry: NOW + 10 * D, tier: "mid" })?.id).toBe(pid("05"));
    expect(pickBorrowOffer(t, { expiry: NOW + 99 * D, tier: "low" })).toBeUndefined();
  });
});

describe("pickLendOffer", () => {
  const t = termsFor(pools as never, q);
  it("apr: highest fixed APR among priced open pools across maturities", () => {
    const best = pickLendOffer(t, { goal: "apr" })!;
    const all = t.flatMap((x) => x.offers).filter((o) => o.priced && o.graduated);
    expect(best.apr).toBe(Math.max(...all.map((o) => o.apr)));
  });
  it("safe: the lowest buy-back price", () => {
    expect(pickLendOffer(t, { goal: "safe" })?.id).toBe(pid("01"));
    expect(pickLendOffer(t, { goal: "safe", expiry: NOW + 10 * D })?.id).toBe(pid("05"));
  });
  it("nothing priced: no pick", () => {
    expect(pickLendOffer(termsFor([row(pid("0a"), { lastClearingPrice: 0n })] as never, q), { goal: "apr" })).toBeUndefined();
  });
});

describe("amounts", () => {
  const o = termsFor(pools as never, q)[0]!.offers[1]!; // price 2900, buy-back 3000, 18-decimal collateral
  it("receive, repay, units for a target and lender units round like the contract", () => {
    expect(borrowReceive(o, E18 / 2n)).toBe(1450_000000n);
    expect(borrowRepay(o, 1n)).toBe(1n); // rounds up
    expect(unitsForQuote(o, 2900_000000n)).toBe(E18);
    expect(unitsForQuote(o, 1n) * 2900_000000n >= 1n * E18).toBe(true);
    expect(lendUnits(o, 2900_000000n)).toBe(E18);
    expect(lendPayout(o, E18)).toBe(3000_000000n);
  });
});

describe("pairsOf", () => {
  it("lists each pair once, pairs with open pools first", () => {
    const p = pairsOf([...pools, row(pid("0b"), { asset: NAT, quote: USDC, status: Status.Closed })] as never, NOW, 1000n);
    expect(p).toHaveLength(3);
    expect(p.at(-1)!.openPools).toBe(0);
    expect(p.find((x) => x.asset === WETH)!.kinds).toEqual([Kind.American]);
  });
});

describe("vaults", () => {
  it("roles from the deployment addresses, else from the symbol", () => {
    const vs = { pegged: "0x01", usdLow: "0x02", usdHigh: "0x03" };
    expect(vaultRole({ address: "0x01", strikeRule: 0, symbol: "x" }, vs)).toBe("pegged");
    expect(vaultRole({ address: "0x03", strikeRule: 1, symbol: "x" }, vs)).toBe("usd-high");
    expect(vaultRole({ address: "0x09", strikeRule: 0, symbol: "rvUSDC-NATIVE-Low" })).toBe("usd-low");
    expect(vaultRole({ address: "0x09", strikeRule: 0, symbol: "rvNATIVE-Pegged" })).toBe("pegged");
  });
  it("share value at NAV", () => {
    expect(vaultSharesValue({ totalAssets: 200n, totalSupply: 100n }, 10n)).toBe(20n);
    expect(vaultSharesValue({ totalAssets: 0n, totalSupply: 0n }, 10n)).toBe(0n);
  });
});

describe("summarizePortfolio", () => {
  const live = row(pid("11"));
  const inWindow = row(pid("12"), { expiry: NOW - 60, status: Status.Window, windowEnd: 2000n });
  const closed = row(pid("13"), { expiry: NOW - D, status: Status.Closed, quoteBal: 3000_000000n, assetBal: E18, surplusBal: 0n });
  const positions = {
    [live.id]: { c: 0n, r: 2n * E18, locked: E18 / 2n },
    [inWindow.id]: { c: 0n, r: E18, locked: 0n },
    [closed.id]: { c: E18, r: 0n, locked: 0n },
  };
  const s = summarizePortfolio({
    pools: [live, inWindow, closed] as never,
    positions,
    supplies: { [closed.id]: { c: 2n * E18, r: 0n } },
    pending: { [USDC]: 5n, [WETH]: 0n },
    vaults: [],
    now: NOW,
    block: 1000n,
  });

  it("loans: free units, repay amount, what is possible now", () => {
    const a = s.borrows.find((b) => b.pool.id === live.id)!;
    expect([a.free, a.repay, a.canRepay, a.canRollover]).toEqual([(3n * E18) / 2n, 4500_000000n, true, true]);
    const w = s.borrows.find((b) => b.pool.id === inWindow.id)!;
    expect([w.canRepay, w.lapsed]).toEqual([true, false]);
  });

  it("lending: payout if repaid and the claim after close", () => {
    expect(s.lends).toHaveLength(1);
    expect(s.lends[0]!.claim).toEqual(claimEstimate(closed, E18, 2n * E18));
    expect(s.lends[0]!.claim).toEqual({ quote: 1500_000000n, asset: E18 / 2n });
  });

  it("withdrawable balances and the attention count (open window + claim + withdrawal)", () => {
    expect(s.withdrawable).toEqual([{ token: USDC, amount: 5n }]);
    expect(s.attention).toBe(3);
  });
});
