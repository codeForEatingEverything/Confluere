/** Roll-over targets: same pair and kind, later maturity, open; default keeps the buy-back price when it can. */
import { describe, expect, it } from "vitest";
import { Kind, Status } from "@confluere/sdk";
import { defaultRolloverTarget, rolloverTargets, rolloverTries, rolloverTtl } from "../src/lib/rollover";
import { LST, NOW, pid, row } from "./fixtures";

describe("rollover targets", () => {
  const from = row(pid("01"), { strike: 3000_000000n });
  const pools = [
    from,
    row(pid("02"), { expiry: NOW + 10 * 86_400, strike: 2900_000000n }),
    row(pid("03"), { expiry: NOW + 10 * 86_400, strike: 3000_000000n }),
    row(pid("04"), { expiry: NOW + 17 * 86_400, strike: 3000_000000n }),
    row(pid("05"), { expiry: NOW + 10 * 86_400, kind: Kind.European }),
    row(pid("06"), { expiry: NOW + 10 * 86_400, asset: LST }),
    row(pid("07"), { expiry: NOW + 10 * 86_400, status: Status.Closed }),
  ];
  it("lists later open pools of the same pair and kind", () => {
    expect(rolloverTargets(from as never, pools as never).map((p) => p.id)).toEqual([pid("02"), pid("03"), pid("04")]);
  });
  it("defaults to the next maturity at the same buy-back price", () => {
    expect(defaultRolloverTarget(from as never, pools as never)?.id).toBe(pid("03"));
    expect(defaultRolloverTarget(from as never, [from] as never)).toBeUndefined();
  });
  it("ttl covers the batches until maturity plus the window's tries", () => {
    expect(rolloverTries(300, 1, 120)).toBe(2);
    expect(rolloverTries(300, null, 120)).toBeUndefined();
    expect(rolloverTtl({ now: 0, fromExpiry: 120 * 500, targetInterval: 120, tries: 2 })).toEqual({ ttl: 506, capped: false });
    expect(rolloverTtl({ now: 0, fromExpiry: 120 * 2000, targetInterval: 120 }).capped).toBe(true);
  });
});
