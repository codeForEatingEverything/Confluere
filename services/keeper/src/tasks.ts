import { confluereAbi, vaultAbi, seatRegistryAbi, marketId, Side, Status, type Deployment } from "@confluere/sdk";
import { BaseError, type Address, type Hex } from "viem";
import type { Clients } from "./chain.js";
import {
  batchOf,
  deadOrders,
  dueAction,
  missedBatchEnd,
  pokeDue,
  rolloverDead,
  rolloverRecheck,
  type BookOrder,
  type OldPool,
  type PoolSnapshot,
  worthSettling,
} from "./plan.js";

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const PURGE_CHUNK = 50;
/** OrderSet.FLAG_ROLLOVER: the order's units come from an old pool (linkedPool) and die with its window. */
const FLAG_ROLLOVER = 1;

export class Tasks {
  private lastPoke = new Map<Address, number>();

  constructor(
    private c: Clients,
    private d: Deployment,
    private opts: { settleDelayS: number; pokeLeadS: number; closeMaxBids: bigint; settleEmpty?: boolean; settleTouchedOnly?: boolean },
    private log: Log,
  ) {}

  async snapshot(pid: Hex): Promise<PoolSnapshot> {
    const core = this.d.confluere;
    const [v, next] = await Promise.all([
      this.c.pub.readContract({ address: core, abi: confluereAbi, functionName: "pool", args: [pid] }),
      this.c.pub.readContract({ address: core, abi: confluereAbi, functionName: "nextBatchAt", args: [pid] }),
    ]);
    return {
      asset: v.key.asset,
      quote: v.key.quote,
      kind: Number(v.key.kind),
      batchInterval: Number(v.batchInterval),
      status: v.status as Status,
      expiry: Number(v.key.expiry),
      windowEnd: v.windowEnd,
      pausedUntil: v.pausedUntil,
      nextBatchAt: Number(next),
      settleCount: Number(v.settleCount),
    };
  }

  /** Last completed walk per pool, and when a live rollover order's verdict can next change. */
  private purgedAt = new Map<Hex, { mark: string; block?: bigint; time?: number }>();

  /**
   * Refund orders that can no longer trade (blueprint: ttl spent, the pool stopped trading, or a rollover order's old
   * window ended) so their escrow does not wait for the owner to cancel. `purge` is permissionless and skips ids it
   * cannot remove. The book is walked only when the pool's settle count or status changed since the last complete
   * walk, or when a rollover order seen alive may have died since. A walk whose purge failed is retried next tick.
   */
  async runPurge(pid: Hex, snap: PoolSnapshot, nowS: number, block: bigint): Promise<number> {
    if (snap.status === Status.None) return 0;
    const mark = purgeMark(snap, nowS);
    const prev = this.purgedAt.get(pid);
    if (
      prev?.mark === mark &&
      !(prev.block !== undefined && block >= prev.block) &&
      !(prev.time !== undefined && nowS >= prev.time)
    ) {
      return 0;
    }
    const core = this.d.confluere;
    const tradingOver = snap.status !== Status.Open || nowS >= snap.expiry;
    const settleCount = snap.settleCount ?? 0;
    const oldPools = new Map<Hex, OldPool>();
    const recheck: { block?: bigint; time?: number } = {};
    const orders: BookOrder[] = [];
    for (const side of [Side.Sell, Side.Buy, Side.NcSell, Side.NcBuy]) {
      const [head] = await this.c.pub.readContract({ address: core, abi: confluereAbi, functionName: "bookHead", args: [pid, side] });
      for (let id = head, n = 0; id !== 0n && n < 1024; n++) {
        const o = await this.c.pub.readContract({ address: core, abi: confluereAbi, functionName: "order", args: [pid, id] });
        const bo: BookOrder = { id, side, deadline: Number(o[6]) };
        // only rollover sells (FLAG_ROLLOVER) can die through their old pool; autoSell sells (also linked) die by ttl or
        // the target pool's expiry like any order. Skip the lookup when the order is dead anyway.
        if (side === Side.Sell && (Number(o[2]) & FLAG_ROLLOVER) !== 0 && !tradingOver && bo.deadline > settleCount) {
          const src = await this.c.pub.readContract({ address: core, abi: confluereAbi, functionName: "linkedPool", args: [pid, id] });
          if (BigInt(src) !== 0n) {
            const old = oldPools.get(src) ?? (await this.oldPool(src));
            oldPools.set(src, old);
            bo.rolloverDead = rolloverDead(old, nowS, block);
            if (!bo.rolloverDead) {
              const r = rolloverRecheck(old, nowS, block);
              if (r.block !== undefined && (recheck.block === undefined || r.block < recheck.block)) recheck.block = r.block;
              if (r.time !== undefined && (recheck.time === undefined || r.time < recheck.time)) recheck.time = r.time;
            }
          }
        }
        orders.push(bo);
        id = o[7];
      }
    }
    const dead = deadOrders(orders, settleCount, tradingOver);
    let sent = 0;
    for (let i = 0; i < dead.length; i += PURGE_CHUNK) {
      sent += await this.send("purge", [pid, dead.slice(i, i + PURGE_CHUNK)], pid);
    }
    // `send` returns 0 on any failure (rate limit, dropped connection): leave the mark unset so the next tick retries
    if (sent === Math.ceil(dead.length / PURGE_CHUNK)) this.purgedAt.set(pid, { mark, ...recheck });
    return sent;
  }

  private async oldPool(pid: Hex): Promise<OldPool> {
    const core = this.d.confluere;
    const v = await this.c.pub.readContract({ address: core, abi: confluereAbi, functionName: "pool", args: [pid] });
    const e = await this.c.pub.readContract({ address: core, abi: confluereAbi, functionName: "expiryWindowEnd", args: [v.key.expiry] });
    return { status: v.status as Status, expiry: Number(v.key.expiry), windowEnd: BigInt(v.windowEnd), expiryWindowEnd: BigInt(e) };
  }

  private markets = new Map<string, { asset: Address; quote: Address; kind: number }>();
  private marketPools = new Map<string, { id: Hex; expiry: number; status: Status; interval: number }[]>();
  private graduated = new Set<string>();
  /** Batch in which each throttled non-pool task last ran (`grad:<market>`, `seat:<market>`, `roll:<vault>`). */
  private ranIn = new Map<string, number>();
  private closedPools = new Set<Hex>();
  /**
   * A pool was seen closed for the first time in this tick's `runPools`: graduation and vault rolls that were waiting
   * on it may pass now, so they are checked without waiting for the next batch.
   */
  private poolClosed = false;

  /**
   * At most once per base batch per key. Graduation, seat and vault state only moves at batch boundaries (or when a
   * pool closes), so checking every tick would only spend the public RPC's rate limit.
   */
  private oncePerBatch(key: string, nowS: number): boolean {
    const b = batchOf(nowS, this.d.gridAnchor, this.d.batchInterval);
    if (this.ranIn.get(key) === b) return false;
    this.ranIn.set(key, b);
    return true;
  }

  /**
   * Pools that need no more reads: seen Closed and their book walked and purged. Their `marketPools` entry stays, so
   * `runSeats` can still use them as slash evidence for an old missed batch without a fresh read.
   */
  private done = new Set<Hex>();
  /**
   * Due batches whose whole book was read empty, keyed by pool: the pool's `nextBatchAt` (fixed until somebody settles)
   * and the base batch of the read. The book is read again only when either changes or a new order was placed in the
   * pool (`touched`), so an empty pool that stays due costs no book reads on every tick.
   */
  private emptyAt = new Map<Hex, { next: number; batch: number }>();
  /** SETTLE_TOUCHED_ONLY: pools that got a new order since their last settleBatch (seeded with every pool at start). */
  private unsettled = new Set<Hex>();
  private seeded = false;

  /**
   * One pass over every known pool. Returns how many transactions were sent. A failing pool does not stop the rest.
   * `touched` holds pools that got new orders since the last pass (from the discovery log scan).
   */
  async runPools(pools: Iterable<Hex>, nowS: number, block: bigint, touched?: Iterable<Hex>): Promise<number> {
    this.poolClosed = false;
    for (const pid of touched ?? []) {
      this.emptyAt.delete(pid);
      this.unsettled.add(pid);
    }
    if (!this.seeded) {
      for (const pid of pools) this.unsettled.add(pid); // the first pass settles whatever is due once
      this.seeded = true;
    }
    let sent = 0;
    for (const pid of pools) {
      if (this.done.has(pid)) continue;
      try {
        sent += await this.runPool(pid, nowS, block);
      } catch (e) {
        this.log("pool failed", { pool: pid, reason: short(e) });
      }
    }
    return sent;
  }

  /**
   * The due batch is worth settling: the book holds at least one order on any side (see `worthSettling`). An empty
   * verdict is cached per (pool, nextBatchAt, base batch) and dropped when the pool gets a new order.
   */
  private async bookWorthSettling(pid: Hex, snap: PoolSnapshot, nowS: number): Promise<boolean> {
    const batch = batchOf(nowS, this.d.gridAnchor, this.d.batchInterval);
    const cached = this.emptyAt.get(pid);
    if (cached && cached.next === snap.nextBatchAt && cached.batch === batch) return false;
    const counts: number[] = [];
    for (const side of [Side.Sell, Side.Buy, Side.NcSell, Side.NcBuy]) {
      const [, count] = await this.c.pub.readContract({ address: this.d.confluere, abi: confluereAbi, functionName: "bookHead", args: [pid, side] });
      counts.push(Number(count));
    }
    const worth = worthSettling(counts[0]!, counts[1]!, counts[2]!, counts[3]!);
    if (worth) this.emptyAt.delete(pid);
    else {
      this.emptyAt.set(pid, { next: snap.nextBatchAt, batch });
      // nothing to purge in an empty book: count it as walked so runPurge does not read the same heads again
      this.purgedAt.set(pid, { mark: purgeMark(snap, nowS) });
    }
    return worth;
  }

  private async runPool(pid: Hex, nowS: number, block: bigint): Promise<number> {
    const snap = await this.snapshot(pid);
    if (snap.asset && snap.quote && snap.kind !== undefined) {
      const key = `${snap.asset}-${snap.quote}-${snap.kind}`;
      this.markets.set(key, { asset: snap.asset, quote: snap.quote, kind: snap.kind });
      const list = (this.marketPools.get(key) ?? []).filter((p) => p.id !== pid);
      list.push({ id: pid, expiry: snap.expiry, status: snap.status, interval: snap.batchInterval ?? this.d.batchInterval });
      this.marketPools.set(key, list);
    }
    if (snap.status === Status.Closed && !this.closedPools.has(pid)) {
      this.closedPools.add(pid);
      this.poolClosed = true;
    }
    const action = dueAction(snap, nowS, block, this.opts.settleDelayS);
    if (action === "none") {
      const sent = await this.runPurge(pid, snap, nowS, block);
      // a Closed pool never changes again once its book is walked and purged (the mark is only set after a complete walk)
      if (snap.status === Status.Closed && this.purgedAt.get(pid)?.mark.startsWith(`${Status.Closed}:`)) this.done.add(pid);
      return sent;
    }
    if (action === "settle") {
      // only a completely empty book is skipped: a one-sided book still needs settling so ttl advances and long-tail
      // cancels unlock (see worthSettling)
      // gas budget mode: an untouched pool waits; the core catches up on skipped batches at the next settle
      if (this.opts.settleTouchedOnly && !this.unsettled.has(pid)) return this.runPurge(pid, snap, nowS, block);
      if (!this.opts.settleEmpty && !(await this.bookWorthSettling(pid, snap, nowS))) return this.runPurge(pid, snap, nowS, block);
      const n = await this.send("settleBatch", [pid], pid);
      if (n > 0) this.unsettled.delete(pid);
      return n;
    }
    if (action === "mature") return this.send("mature", [pid], pid);
    return this.send("closeWindow", [pid, this.opts.closeMaxBids], pid);
  }

  /**
   * Graduation is permissionless: once the latest expiry has passed, try every known market that has not
   * graduated, once per batch or after a pool closed. The core checks the four-cycle rule; a failing simulation just means "not yet".
   * A market graduated by someone else is read from the core and never tried again.
   */
  async runGraduation(nowS: number): Promise<number> {
    const { gridAnchor, gridPeriod } = this.d;
    if (nowS <= gridAnchor + 4 * gridPeriod) return 0;
    const lastExpiry = BigInt(gridAnchor + Math.floor((nowS - 1 - gridAnchor) / gridPeriod) * gridPeriod);
    let sent = 0;
    for (const [key, m] of this.markets) {
      if (this.graduated.has(key)) continue;
      if (!this.oncePerBatch(`grad:${key}`, nowS) && !this.poolClosed) continue;
      try {
        const done = await this.c.pub.readContract({
          address: this.d.confluere,
          abi: confluereAbi,
          functionName: "graduated",
          args: [marketId(m.asset, m.quote, m.kind)],
        });
        if (done) {
          this.graduated.add(key);
          continue;
        }
        const { request } = await this.c.pub.simulateContract({
          address: this.d.confluere,
          abi: confluereAbi,
          functionName: "graduate",
          args: [m.asset, m.quote, m.kind, lastExpiry],
          account: this.c.account,
        });
        const hash = await this.c.wallet.writeContract(request);
        await this.c.pub.waitForTransactionReceipt({ hash });
        this.graduated.add(key);
        this.log("graduate success", { market: key, lastExpiry: lastExpiry.toString(), hash });
        sent++;
      } catch {
        // not eligible yet
      }
    }
    return sent;
  }

  /**
   * Seat duties (blueprint §9), once per batch per market with a holder: split the market's new spread share so the
   * holder's part becomes withdrawable (`runSplit`), and slash a holder who skipped a whole batch. Both are
   * permissionless; the keeper only makes sure somebody does them. Slash evidence is a pool of the same market that was
   * trading through the missed batch.
   */
  async runSeats(nowS: number): Promise<number> {
    const reg = this.d.seatRegistry;
    if (!reg) return 0;
    const { gridAnchor, batchInterval } = this.d;
    let sent = 0;
    for (const [key, m] of this.markets) {
      if (!this.oncePerBatch(`seat:${key}`, nowS)) continue;
      try {
        const seat = await this.c.pub.readContract({
          address: reg,
          abi: seatRegistryAbi,
          functionName: "seats",
          args: [marketId(m.asset, m.quote, m.kind)],
        });
        const holder = seat[0];
        const lastQuoted = Number(seat[6]);
        if (holder === "0x0000000000000000000000000000000000000000") continue;
        sent += await this.runSplit(key, m);
        const evidence = (this.marketPools.get(key) ?? []).find((p) => {
          const end = missedBatchEnd(gridAnchor, batchInterval, lastQuoted, p.interval);
          return p.status !== Status.None && end <= nowS && p.expiry >= end;
        });
        if (!evidence) continue;
        const { request } = await this.c.pub.simulateContract({
          address: reg,
          abi: seatRegistryAbi,
          functionName: "slash",
          args: [evidence.id],
          account: this.c.account,
        });
        const hash = await this.c.wallet.writeContract(request);
        await this.c.pub.waitForTransactionReceipt({ hash });
        this.log("seat slashed", { market: key, holder, missedBatch: lastQuoted + 1, hash });
        sent++;
      } catch (e) {
        this.log("slash skipped", { market: key, reason: String(e).slice(0, 120) });
      }
    }
    return sent;
  }

  /** Per market: the core's cumulative `marketFees` value known to be split already. */
  private feesSplitSeen = new Map<string, bigint>();

  /**
   * Call SeatRegistry.split when the market's cumulative spread share grew since the last split. Steady state costs
   * one read (`core.marketFees`); the registry's `feesSplit` is read only when that value grew, so a split somebody
   * else already made is not paid for again.
   */
  private async runSplit(key: string, m: { asset: Address; quote: Address; kind: number }): Promise<number> {
    const reg = this.d.seatRegistry!;
    const mid = marketId(m.asset, m.quote, m.kind);
    try {
      const fees = await this.c.pub.readContract({ address: this.d.confluere, abi: confluereAbi, functionName: "marketFees", args: [mid] });
      if (fees <= (this.feesSplitSeen.get(key) ?? 0n)) return 0;
      const split = await this.c.pub.readContract({ address: reg, abi: seatRegistryAbi, functionName: "feesSplit", args: [mid] });
      if (fees <= split) {
        this.feesSplitSeen.set(key, fees);
        return 0;
      }
      const { request } = await this.c.pub.simulateContract({
        address: reg,
        abi: seatRegistryAbi,
        functionName: "split",
        args: [m.asset, m.quote, m.kind],
        account: this.c.account,
      });
      const hash = await this.c.wallet.writeContract(request);
      await this.c.pub.waitForTransactionReceipt({ hash });
      this.feesSplitSeen.set(key, fees);
      this.log("fees split", { market: key, fees: fees.toString(), hash });
      return 1;
    } catch (e) {
      this.log("split skipped", { market: key, reason: short(e) });
      return 0;
    }
  }

  /**
   * Poke each vault once per batch, just before the boundary. Roll is checked once per batch, or right after a pool
   * closed, and only simulated when Vault.roll could pass: the target expiry has passed or a deposit or redemption is
   * waiting.
   */
  /**
   * A poke only places orders when the vault has idle funds and a graduated target pool. Vault.poke does not revert
   * when there is nothing to invest, so without this check the keeper pays a transaction per vault per batch for
   * nothing (on Monad every transaction pays its whole gas limit).
   */
  private async pokeUseful(vault: Address): Promise<boolean> {
    const investable = (await this.c.pub.readContract({ address: vault, abi: vaultAbi, functionName: "investable" })) as bigint;
    if (investable === 0n) return false;
    const assets = (await this.c.pub.readContract({ address: vault, abi: vaultAbi, functionName: "assets" })) as readonly Address[];
    for (const a of assets) {
      const pid = (await this.c.pub.readContract({ address: vault, abi: vaultAbi, functionName: "targetPool", args: [a] })) as Hex;
      if (pid !== ZERO32) return true;
    }
    return false;
  }

  async runVaults(vaults: Iterable<Address>, nowS: number): Promise<number> {
    let sent = 0;
    const { gridAnchor, batchInterval } = this.d;
    for (const vault of vaults) {
      try {
        const last = this.lastPoke.get(vault) ?? -1;
        if (pokeDue(nowS, gridAnchor, batchInterval, last, this.opts.pokeLeadS)) {
          this.lastPoke.set(vault, Math.floor((nowS - gridAnchor) / batchInterval));
          if (await this.pokeUseful(vault)) sent += await this.sendVault(vault, "poke");
        }
        const due = this.oncePerBatch(`roll:${vault}`, nowS);
        if (!due && !this.poolClosed) continue;
        const [target, deposits, redeems] = await Promise.all([
          this.c.pub.readContract({ address: vault, abi: vaultAbi, functionName: "targetExpiry" }),
          this.c.pub.readContract({ address: vault, abi: vaultAbi, functionName: "pendingDepositAssets" }),
          this.c.pub.readContract({ address: vault, abi: vaultAbi, functionName: "pendingRedeemShares" }),
        ]);
        if (BigInt(nowS) >= BigInt(target) || deposits > 0n || redeems > 0n) sent += await this.sendVault(vault, "roll");
      } catch (e) {
        this.log("vault failed", { vault, reason: short(e) });
      }
    }
    return sent;
  }

  /** Simulate first; only send when the call would succeed. Reverts in simulation are normal (nothing to do). */
  private async send(fn: "settleBatch" | "mature" | "closeWindow" | "purge", args: readonly unknown[], pid: Hex): Promise<number> {
    try {
      const { request } = await this.c.pub.simulateContract({
        address: this.d.confluere,
        abi: confluereAbi,
        functionName: fn,
        args: args as never,
        account: this.c.account,
      });
      const hash = await this.c.wallet.writeContract(request);
      const rc = await this.c.pub.waitForTransactionReceipt({ hash });
      this.log(`${fn} ${rc.status}`, { pool: pid, hash, gas: rc.gasUsed.toString() });
      return 1;
    } catch (e) {
      this.log(`${fn} skipped`, { pool: pid, reason: short(e) });
      return 0;
    }
  }

  private async sendVault(vault: Address, fn: "poke" | "roll"): Promise<number> {
    try {
      const { request } = await this.c.pub.simulateContract({ address: vault, abi: vaultAbi, functionName: fn, account: this.c.account });
      const hash = await this.c.wallet.writeContract(request);
      await this.c.pub.waitForTransactionReceipt({ hash });
      this.log(`vault ${fn}`, { vault, hash });
      return 1;
    } catch {
      return 0;
    }
  }
}

/** What a complete purge walk depends on: a new walk is due when any of these changes. */
function purgeMark(snap: PoolSnapshot, nowS: number): string {
  return `${snap.status}:${snap.settleCount}:${nowS >= snap.expiry}`;
}

function short(e: unknown): string {
  if (e instanceof BaseError) return e.shortMessage;
  return String(e).slice(0, 120);
}
