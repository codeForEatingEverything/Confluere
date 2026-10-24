/** Pure helpers behind the v3 screens: quotes, the pool pick, deadlines, the vocabulary, order status. */
import { describe, expect, it } from "vitest";
import { Kind, Status, impliedApr, quoteDown, repayAmount, rolloverTopUp } from "@confluere/sdk";
import { NOW, pid, row } from "./fixtures";
import { borrowQuote, defaultBorrowLimit, defaultMoveBps, fixedReturn, lendQuote, minUnits, refToUnits, DAY } from "../src/lib/quote";
import { defaultLevel, levelChoices, pickOffer, termChoices, LEVEL_LABEL } from "../src/lib/bestPool";
import { termsFor } from "../src/lib/product";
import { repayDeadline, windowLeft } from "../src/lib/deadline";
import { vaultLine, vaultName, vaultSentences, networkName, priceSource } from "../src/lib/vocab";
import { watchState } from "../src/lib/orderStatus";
import { nextRoundAt, poolState, roundProgress } from "../src/lib/view";
import { fmtExpiry, fmtToken, fmtWait, pctSigned } from "../src/lib/format";
import { rolloverPlan } from "../src/lib/actions";

const E18 = 10n ** 18n;
const WETH = "0x00000000000000000000000000000000000000a1" as const;
const USDC = "0x00000000000000000000000000000000000000b2" as const;

describe("borrow quote (§8.1.4) matches the SDK", () => {
  const p = row(pid("a1")) as any; // last traded 2,900, buy-back 3,000, 3 days
  it("receive, repay, cost and APR at the last traded price", () => {
    const q = borrowQuote({ pool: p, units: 2n * E18, now: NOW });
    expect(q.price).toBe(2900_000000n);
    expect(q.estimate).toBe(false);
    expect(q.receive).toBe(quoteDown(2n * E18, 2900_000000n, E18));
    expect(q.repay).toBe(repayAmount(2n * E18, 3000_000000n, E18));
    expect(q.cost).toBe(200_000000n);
    expect(q.periodReturn).toBeCloseTo(100 / 2900, 9);
    expect(q.apr).toBeCloseTo(impliedApr(2900_000000n, 3000_000000n, 3 * DAY), 9);
    expect(q.showApr).toBe(true);
    expect(q.guard).toBe((2900_000000n * 9900n) / 10_000n); // 1% move in a mainstream market
  });
  it("an unpriced pool quotes from the reference price, marked as an estimate; nothing at all gives zero", () => {
    const u = { ...p, lastClearingPrice: 0n };
    const q = borrowQuote({ pool: u, units: E18, now: NOW, ref: 2800_000000n });
    expect(q.estimate).toBe(true);
    expect(q.receive).toBe(2800_000000n);
    expect(borrowQuote({ pool: u, units: E18, now: NOW }).receive).toBe(0n);
  });
  it("a reference price above the buy-back price is capped below it: the rate is never negative", () => {
    const u = { ...p, lastClearingPrice: 0n };
    const q = borrowQuote({ pool: u, units: E18, now: NOW, ref: u.strike + 500_000000n });
    expect(q.price).toBe(u.strike - 1n);
    expect(q.apr).toBeGreaterThanOrEqual(0);
    expect(q.periodReturn).toBeGreaterThanOrEqual(0);
    expect(fixedReturn({ ...u, lastClearingPrice: u.strike + 1n }, NOW).apr).toBe(0);
  });
  it("your own minimum price is used as the price; terms under a day show no APR", () => {
    const q = borrowQuote({ pool: { ...p, expiry: NOW + 3600 }, units: E18, now: NOW, limit: 2700_000000n });
    expect(q.price).toBe(2700_000000n);
    expect(q.showApr).toBe(false);
  });
  it("defaults: 0.5% move and 97% minimum in pegged markets, 1% and 90% elsewhere", () => {
    expect(defaultMoveBps({ bandBps: 150 })).toBe(50);
    expect(defaultMoveBps({ bandBps: 800 })).toBe(100);
    expect(defaultBorrowLimit({ strike: 1000n, bandBps: 150 })).toBe(970n);
    expect(defaultBorrowLimit({ strike: 1000n, bandBps: 800 })).toBe(900n);
  });
  it("minimum amount: the core's minimum order value at the buy-back price, rounded up", () => {
    expect(minUnits(p, 100_000000n)).toBe((100_000000n * E18 + 3000_000000n - 1n) / 3000_000000n);
    expect(minUnits(p, 0n)).toBe(0n);
  });
  it("reference prices convert to quote base units", () => {
    expect(refToUnits(32.35, 6)).toBe(32_350000n);
    expect(refToUnits(12.94, 18)).toBe(12_940000000000000000n);
    expect(refToUnits(null, 6)).toBeUndefined();
  });
});

describe("lend quote", () => {
  it("units bought below the buy-back price, paid the buy-back price if repaid", () => {
    const p = row(pid("a1")) as any;
    const q = lendQuote({ pool: p, amount: 2900_000000n, now: NOW });
    expect(q.units).toBe(E18);
    expect(q.payout).toBe(3000_000000n);
    expect(q.periodReturn).toBeCloseTo(100 / 2900, 9);
    expect(fixedReturn(p, NOW).priced).toBe(true);
    expect(fixedReturn({ ...p, lastClearingPrice: 0n }, NOW).priced).toBe(false);
  });
});

describe("pool pick (§8.1.3)", () => {
  const pools = [
    row(pid("a1"), { strike: 3000_000000n }),
    row(pid("a2"), { strike: 3100_000000n }),
    row(pid("a3"), { strike: 3200_000000n }),
    row(pid("b1"), { expiry: NOW + 7 * DAY, strike: 3000_000000n }),
    row(pid("b2"), { expiry: NOW + 7 * DAY, strike: 3300_000000n }),
    row(pid("c1"), { expiry: NOW + 9 * DAY }),
    row(pid("d1"), { expiry: NOW + 10 * DAY }),
    row(pid("e1"), { expiry: NOW + 11 * DAY }),
    row(pid("x1"), { expiry: NOW + 2 * DAY, status: Status.Closed }),
  ] as any[];
  const terms = termsFor(pools, { asset: WETH, quote: USDC, kind: Kind.American, now: NOW, block: 1000n });
  it("term chips: open maturities only, soonest first, at most four", () => {
    const t = termChoices(terms);
    expect(t.map((x) => x.expiry)).toEqual([NOW + 3 * DAY, NOW + 7 * DAY, NOW + 9 * DAY, NOW + 10 * DAY]);
  });
  it("three or more buy-back prices: lowest, median, highest; Balanced by default", () => {
    const l = levelChoices(terms[0]);
    expect(l.map((x) => [x.level, x.offer.strike])).toEqual([
      ["low", 3000_000000n],
      ["mid", 3100_000000n],
      ["high", 3200_000000n],
    ]);
    expect(defaultLevel(terms[0])).toBe("mid");
    expect(LEVEL_LABEL).toEqual({ low: "Repay less", mid: "Balanced", high: "Receive more" });
  });
  it("two prices: only the ends, Repay less by default; one price: no chips", () => {
    const t2 = terms.find((t) => t.expiry === NOW + 7 * DAY);
    expect(levelChoices(t2).map((x) => x.level)).toEqual(["low", "high"]);
    expect(defaultLevel(t2)).toBe("low");
    expect(levelChoices(terms.find((t) => t.expiry === NOW + 9 * DAY))).toEqual([]);
  });
  it("picks the chosen chip, falls back to the soonest term and the default level", () => {
    expect(pickOffer(terms, undefined, "mid").offer?.id).toBe(pid("a2"));
    expect(pickOffer(terms, NOW + 7 * DAY, "high").offer?.id).toBe(pid("b2"));
    expect(pickOffer(terms, NOW + 7 * DAY, "mid").offer?.id).toBe(pid("b1"));
    expect(pickOffer(terms, NOW + 9 * DAY, "mid").offer?.id).toBe(pid("c1"));
    expect(pickOffer([], undefined, "mid").offer).toBeUndefined();
  });
});

describe("repay deadline (blocks, marked ≈)", () => {
  const p = row(pid("a1")) as any;
  it("before maturity: maturity + window blocks × measured block time", () => {
    expect(repayDeadline(p, { now: NOW, block: 1000n, spb: 2, windowBlocks: 300 })).toEqual({ ts: p.expiry + 600, approx: true, known: true });
  });
  it("in the window: what is left of it from the current block", () => {
    const w = { ...p, status: Status.Window, windowEnd: 1300n };
    expect(repayDeadline(w, { now: NOW, block: 1000n, spb: 1, windowBlocks: 300 }).ts).toBe(NOW + 300);
    expect(windowLeft(w, 1000n, 1)).toBe(300);
  });
  it("without a block time only the maturity is known", () => {
    expect(repayDeadline(p, { now: NOW, block: 1000n, spb: null, windowBlocks: 300 })).toEqual({ ts: p.expiry, approx: true, known: false });
  });
});

describe("vocabulary", () => {
  it("vault names (§8.2) and the three fixed sentences (§8.3), word for word", () => {
    expect(vaultName("usd-low", "USDC", "HYPE")).toBe("USDC Conservative vault");
    expect(vaultName("usd-high", "USDC", "HYPE")).toBe("USDC High-yield vault");
    expect(vaultName("pegged", "WMON", "MON")).toBe("MON Pegged vault");
    expect(vaultLine("usd-low", { strikeRule: 0 }, "USDC", "WHYPE", "HYPE")).toBe("Lends USDC to WHYPE borrowers at the lower buy-back price");
    expect(vaultLine("pegged", { strikeRule: 0 }, "WMON", "shMON", "MON")).toBe("Lends MON to shMON borrowers");
    const [a, b, c] = vaultSentences({ strikeRule: 1, capBps: 2500 }, "USDC", "WHYPE");
    expect(a).toBe("This vault lends USDC to borrowers who sold WHYPE into the market. It never buys or holds WHYPE on purpose.");
    expect(b).toBe("If a borrower doesn't repay, the vault receives their WHYPE. When you withdraw, you may get some WHYPE along with USDC.");
    expect(c).toBe("Rule, fixed at deployment: lend at the higher buy-back price, at most 25% of idle funds each round, only into established markets. Nobody can change it.");
    for (const s of [a, b, c]) expect(s).not.toMatch(/stake|LST|liquidat/i);
  });
  it("network names and price sources", () => {
    expect(networkName({ id: 998, name: "HyperEVM", testnet: true })).toBe("HyperEVM Testnet");
    expect(networkName({ id: 31337, name: "Anvil", testnet: true })).toBe("Local (anvil)");
    expect(priceSource(998, WETH, USDC)).toBe("HyperCore spot");
    expect(priceSource(10143, "0xa3", "0xa4", { lst: "0xA3", native: "0xa4", assetSymbol: "shMON" })).toBe("shMON's own rate");
    expect(networkName({ id: 11155111, name: "Sepolia", testnet: true })).toBe("Sepolia Testnet");
    expect(priceSource(11155111, "0xa1", "0xa2")).toBe("ETH / USD spot (mainnet)");
    expect(priceSource(11155111, "0xa3", "0xa4", { lst: "0xA3", native: "0xa4", assetSymbol: "wstETH" })).toBe("wstETH's own rate");
  });
  it("formats: dates without middle dots, waits in words, dollar tokens with two decimals", () => {
    expect(fmtExpiry(Date.UTC(2026, 9, 13, 9, 0) / 1000)).toBe("Tue 13 Oct, 09:00 UTC");
    expect(fmtWait(100)).toBe("2 min");
    expect(fmtWait(33)).toBe("40 s");
    expect(fmtWait(40)).toBe("40 s");
    expect(fmtWait(7500)).toBe("2 h 5 min");
    expect(fmtToken(33_780000n, { decimals: 6, symbol: "USDC" })).toBe("33.78 USDC");
    expect(fmtToken(E18, { decimals: 18, symbol: "WHYPE" })).toBe("1.00 WHYPE");
    expect(pctSigned(0.0067)).toBe("+0.67%");
  });
});

describe("order status after placing (§8.1.8)", () => {
  const w = { side: "borrow" as const, rounds: 4, startRounds: 10, before: { held: 0n, pendingQuote: 0n, pendingAsset: 0n, orderIds: [] } };
  const now = { roundsDone: 10, held: 0n, pendingQuote: 0n, pendingAsset: 0n, open: true, seen: true };
  it("placed, then trying again i of n while rounds pass without a fill", () => {
    expect(watchState(w, now).phase).toBe("placed");
    expect(watchState(w, { ...now, roundsDone: 11 })).toMatchObject({ phase: "retrying", round: 2, of: 4 });
  });
  it("filled when buy-back rights arrive; the quote received is the new withdrawable balance", () => {
    expect(watchState(w, { ...now, roundsDone: 11, held: E18, pendingQuote: 2900_000000n })).toMatchObject({ phase: "filled", received: 2900_000000n, units: E18 });
  });
  it("expired after its rounds, cancelled when it disappears earlier", () => {
    expect(watchState(w, { ...now, roundsDone: 14, open: false, pendingAsset: E18 })).toMatchObject({ phase: "expired", refund: E18 });
    expect(watchState(w, { ...now, roundsDone: 11, open: false })).toMatchObject({ phase: "cancelled" });
  });
});

describe("rounds and states", () => {
  const p = row(pid("a1"), { nextBatchAt: NOW + 30, batchInterval: 120 }) as any;
  it("next round and the ring's progress", () => {
    expect(nextRoundAt(p, NOW)).toBe(NOW + 30);
    expect(nextRoundAt(p, NOW + 31)).toBe(NOW + 150);
    expect(roundProgress(p, NOW)).toBeCloseTo(0.75, 9);
  });
  it("lifecycle in user terms", () => {
    expect(poolState(p, NOW, 1000n)).toBe("open");
    expect(poolState({ ...p, pausedUntil: 2000n }, NOW, 1000n)).toBe("paused");
    expect(poolState({ ...p, status: Status.Window, windowEnd: 1200n }, NOW, 1000n)).toBe("window");
    expect(poolState({ ...p, status: Status.Closed }, NOW, 1000n)).toBe("closed");
  });
});

describe("extend: the most you may add equals the SDK top-up", () => {
  it("rolloverPlan → rolloverTopUp(units, old buy-back, minimum price, rounds)", () => {
    const from = row(pid("a1"), { strike: 3000_000000n }) as any;
    const to = row(pid("b1"), { expiry: NOW + 7 * DAY, lastClearingPrice: 2950_000000n }) as any;
    const plan = rolloverPlan({ from, to, units: E18, now: NOW, spb: 1 }, 300);
    expect(plan.minPrice).toBe((2950_000000n * 9900n) / 10_000n);
    expect(plan.maxTopUp).toBe(rolloverTopUp(E18, 3000_000000n, plan.minPrice, plan.ttl, E18));
  });
});

describe("number formats (review 3)", () => {
  it("two different sub-dollar prices never print the same; columns keep trailing zeros", async () => {
    const { fmtPer } = await import("../src/lib/format");
    const q = { decimals: 6 };
    expect(fmtPer(25_000n, q)).toBe("0.0250");
    expect(fmtPer(26_000n, q)).toBe("0.0260");
    expect(fmtPer(24_100n, q)).toBe("0.0241");
    expect(fmtPer(34_000_000n, q)).toBe("34.00");
    expect(fmtPer(12n * 10n ** 18n, { decimals: 18 })).toBe("12.00");
  });
  it("a non-zero amount never shows as zero", () => {
    expect(fmtToken(4_000n, { decimals: 6, symbol: "USDC" })).toBe("<0.01 USDC");
    expect(fmtToken(123_450_000_000_000n, { decimals: 18, symbol: "WHYPE" })).toBe("0.0001235 WHYPE");
  });
  it("pasted thousands separators keep their value", async () => {
    const { cleanAmount } = await import("../src/components/ui/Amount");
    expect(cleanAmount("1,000", 6)).toBe("1000");
    expect(cleanAmount("1,000.5", 6)).toBe("1000.5");
    expect(cleanAmount("0,5", 6)).toBe("0.5");
  });
});
