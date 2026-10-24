import {
  confluereAbi,
  seatRegistryAbi,
  marketId,
  cTokenId,
  logRange,
  Side,
  Status,
  buyEscrow,
  scaleOf,
  type Deployment,
} from "@confluere/sdk";
import { erc20Abi, getAbiItem, maxUint256, parseEventLogs, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { committed, exitReason, marketDone, quote, type MarketExit, type PoolClass } from "./rules.js";

export type Io = { pub: PublicClient; wallet: WalletClient; account: Account; d: Deployment; chainId: number };

export type BotConfig = {
  pools: { id: Hex; cls: PoolClass }[];
  perBatch: bigint;
  total: bigint;
  endAt: number;
  leadS: number;
  /** Weekly quote volume per market at which the bot leaves that market (deploy parameter; 0 = seats only). */
  exitWeeklyVolume?: bigint;
};

/** A bid of ours still resting in the book: its escrow counts against the cap until we know what it actually paid. */
export type OpenOrder = { id: string; escrow: string; block: string };

/**
 * Persisted across restarts. `spent` is quote actually paid for fills per pool (OrderFilled), not escrow: unfilled
 * escrow comes back to `pending` and is withdrawn, so it must not use up the cap. `claimed` lists closed pools whose
 * C position was already claimed.
 */
export type Saved = {
  spent: Record<string, string>;
  open?: Record<string, OpenOrder[]>;
  claimed?: string[];
  startedAt?: number;
  exited?: string;
  /**
   * A bid was placed that could not be tracked by id (no OrderPlaced log; rare fallback). Its refund cannot be tied to
   * the order leaving the book, so `pending` is polled every tick from then on, across restarts and after exit.
   */
  untracked?: boolean;
};

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

const ZERO = "0x0000000000000000000000000000000000000000";
const orderFilled = getAbiItem({ abi: confluereAbi, name: "OrderFilled" });

const readPool = (pub: PublicClient, core: Address, pid: Hex) =>
  pub.readContract({ address: core, abi: confluereAbi, functionName: "pool", args: [pid] });
type PoolView = Awaited<ReturnType<typeof readPool>>;

export class Bot {
  private lastBatch = new Map<Hex, bigint>();
  /** `pool` views read in the current tick: each pool is read at most once per tick (RPC budget, finding 14). */
  private views = new Map<Hex, PoolView>();
  /** Quote token per pool. A pool key never changes, so this outlives the tick. */
  private quoteOf = new Map<Hex, Address>();
  /**
   * Whether `pending` may have grown since the last withdraw, so `pending` is not polled every tick. Refunds arise when
   * one of our bids leaves the book or we claim. A partial fill also credits the unused escrow to `pending` while the
   * order stays in the book (ClearingLogic._fillBuy); that dead remainder is dropped at the next settleBatch, so its
   * refund is withdrawn about one batch late, nothing is lost. True at start, which covers refunds made while the bot
   * was down.
   */
  private owedMaybe = true;

  constructor(
    private io: Io,
    private cfg: BotConfig,
    private state: Saved,
    private save: () => void,
    private log: Log,
  ) {}

  private get core(): Address {
    return this.io.d.confluere;
  }

  private spentOf(pid: Hex): bigint {
    return BigInt(this.state.spent[pid] ?? "0");
  }

  /** Quote still available to this pool: TOTAL_QUOTE minus what fills paid minus what resting bids escrow. */
  remaining(pid: Hex): bigint {
    const used = committed(this.spentOf(pid), (this.state.open?.[pid] ?? []).map((o) => BigInt(o.escrow)));
    return this.cfg.total > used ? this.cfg.total - used : 0n;
  }

  private async poolView(pid: Hex): Promise<PoolView> {
    const hit = this.views.get(pid);
    if (hit) return hit;
    const v = await readPool(this.io.pub, this.core, pid);
    this.views.set(pid, v);
    if (v.status !== Status.None) this.quoteOf.set(pid, v.key.quote);
    return v;
  }

  async tick(): Promise<void> {
    this.views.clear();
    const block = await this.io.pub.getBlock();
    const now = Number(block.timestamp);
    // Collecting what the bot is owed runs even after it stops quoting: treasury funds must not stay in the core.
    if (this.state.untracked) this.owedMaybe = true;
    await this.reconcile(block.number);
    await this.collect();
    if (this.state.exited) return;
    if (this.state.startedAt === undefined) {
      this.state.startedAt = now;
      this.save();
    }
    const markets = await this.marketExits(now);
    const exitLine = this.cfg.exitWeeklyVolume ?? 0n;
    const why = exitReason({ now, endAt: this.cfg.endAt, markets: [...markets.values()], exitWeeklyVolume: exitLine });
    if (why) {
      this.state.exited = why;
      this.save();
      this.log("bootstrap exit", { reason: why });
      return;
    }
    for (const p of this.cfg.pools) {
      const v = await this.poolView(p.id);
      const m = markets.get(marketId(v.key.asset, v.key.quote, Number(v.key.kind)));
      if (m && marketDone(m, exitLine)) continue; // this market has left bootstrap for good
      await this.quotePool(p.id, p.cls, now);
    }
  }

  /**
   * Settle the books on our bids that left the order book (filled, expired after their one batch, or purged): add what
   * their fills paid to `spent` and release the rest of their escrow from the cap.
   *
   * `order` is read at `head`, the same block the OrderFilled scan ends at. Reading it at latest instead would let a
   * settleBatch mined after `head` remove the order while its fill log sits outside the scanned range: the fill would
   * count as 0 and the order would be dropped for good, so TOTAL_QUOTE could be overspent.
   *
   * An order placed after `head` (a lagging or load-balanced RPC node answered getBlock) is kept unread: at `head` it
   * does not exist yet, so it would look gone with an empty fill range, and its later fill would never be counted.
   */
  async reconcile(head: bigint): Promise<void> {
    const open = this.state.open ?? {};
    let changed = false;
    for (const [pid, list] of Object.entries(open) as [Hex, OpenOrder[]][]) {
      const keep: OpenOrder[] = [];
      for (const o of list) {
        if (BigInt(o.block) > head) {
          keep.push(o);
          continue;
        }
        const [owner] = await this.io.pub.readContract({ address: this.core, abi: confluereAbi, functionName: "order", args: [pid, BigInt(o.id)], blockNumber: head });
        if (owner !== ZERO) {
          keep.push(o);
          continue;
        }
        const paid = await this.filledCost(pid, BigInt(o.id), BigInt(o.block), head);
        this.state.spent[pid] = (this.spentOf(pid) + paid).toString();
        changed = true;
        this.owedMaybe = true; // whatever the fill did not use is refunded to `pending`
        this.log("bootstrap bid done", { pool: pid, order: o.id, escrow: o.escrow, paid });
      }
      if (keep.length) open[pid] = keep;
      else delete open[pid];
    }
    this.state.open = open;
    if (changed) this.save();
  }

  private async filledCost(pid: Hex, id: bigint, from: bigint, head: bigint): Promise<bigint> {
    const chunk = logRange(this.io.chainId);
    let paid = 0n;
    for (let lo = from; lo <= head; lo += chunk) {
      const hi = lo + chunk - 1n < head ? lo + chunk - 1n : head;
      const logs = await this.io.pub.getLogs({ address: this.core, event: orderFilled, args: { poolId: pid, orderId: id }, fromBlock: lo, toBlock: hi });
      // v0.8: a buyer pays the clearing cost plus its 0.015% trade fee; both count against the cap
      for (const l of logs) paid += (l.args.quoteAmount ?? 0n) + (l.args.fee ?? 0n);
    }
    return paid;
  }

  /** Withdraw refunded escrow (pull model) and claim C positions in closed pools. Both only pay the bot itself. */
  async collect(): Promise<void> {
    const me = this.io.account.address;
    const pids = new Set<Hex>([...this.cfg.pools.map((p) => p.id), ...(Object.keys(this.state.spent) as Hex[])]);
    const claimed = new Set(this.state.claimed ?? []);
    for (const pid of pids) {
      if (claimed.has(pid)) continue; // Closed is final: a claimed pool needs no further status reads
      const v = await this.poolView(pid);
      if (v.status !== Status.Closed) continue;
      const c = await this.io.pub.readContract({ address: this.core, abi: confluereAbi, functionName: "balanceOf", args: [me, cTokenId(pid)] });
      if (c > 0n) {
        await this.send("claim", [pid]);
        this.owedMaybe = true;
        this.log("bootstrap claim", { pool: pid, units: c });
      }
      claimed.add(pid);
      this.state.claimed = [...claimed];
      this.save();
    }
    if (!this.owedMaybe) return;
    const quotes = new Set<Address>();
    for (const pid of pids) {
      if (!this.quoteOf.has(pid)) await this.poolView(pid); // fills quoteOf unless the pool does not exist
      const q = this.quoteOf.get(pid);
      if (q) quotes.add(q);
    }
    for (const token of quotes) {
      const owed = await this.io.pub.readContract({ address: this.core, abi: confluereAbi, functionName: "pending", args: [token, me] });
      if (owed === 0n) continue;
      await this.send("withdraw", [token, me]);
      this.log("bootstrap withdraw", { token, amount: owed });
    }
    this.owedMaybe = false; // only after every withdraw went through: a failed one is retried next tick
  }

  private async send(functionName: "claim" | "withdraw", args: readonly unknown[]): Promise<void> {
    const hash = await this.io.wallet.writeContract({
      address: this.core,
      abi: confluereAbi,
      functionName,
      args: args as never,
      account: this.io.account,
      chain: this.io.wallet.chain,
    });
    await this.io.pub.waitForTransactionReceipt({ hash });
  }

  /** Seat holder present for each quoted market (blueprint 9: seats replace the bootstrap MM). */
  /**
   * Per market: seat holder present, and quote volume over the last week (sum of marketStats(m, e).volume over the
   * expiries e in (now - 7 days, next expiry]; one expiry on the weekly grid, seven or eight on the daily grid). The
   * volume read is skipped when no exit line is set.
   */
  private async marketExits(now: number): Promise<Map<Hex, MarketExit>> {
    const reg = this.io.d.seatRegistry;
    const markets = new Set<Hex>();
    for (const p of this.cfg.pools) {
      const v = await this.poolView(p.id);
      markets.add(marketId(v.key.asset, v.key.quote, Number(v.key.kind)));
    }
    const out = new Map<Hex, MarketExit>();
    const { gridAnchor: anchor, gridPeriod: period } = this.io.d;
    for (const m of markets) {
      let seated = false;
      if (reg) {
        const seat = await this.io.pub.readContract({ address: reg, abi: seatRegistryAbi, functionName: "seats", args: [m] });
        seated = seat[0] !== ZERO;
      }
      let weeklyVolume = 0n;
      if ((this.cfg.exitWeeklyVolume ?? 0n) > 0n && period > 0) {
        const next = anchor + (Math.floor((now - anchor) / period) + 1) * period;
        for (let e = next; e > now - 7 * 86_400 && e >= anchor; e -= period) {
          const st = await this.io.pub.readContract({ address: this.core, abi: confluereAbi, functionName: "marketStats", args: [m, BigInt(e)] });
          weeklyVolume += BigInt(st.volume);
        }
      }
      out.set(m, { seated, weeklyVolume });
    }
    return out;
  }

  private async depthAtOrAbove(pid: Hex, limit: bigint): Promise<bigint> {
    let [id] = await this.io.pub.readContract({ address: this.core, abi: confluereAbi, functionName: "bookHead", args: [pid, Side.Buy] });
    let units = 0n;
    while (id !== 0n) {
      const o = await this.io.pub.readContract({ address: this.core, abi: confluereAbi, functionName: "order", args: [pid, id] });
      if (o[4] < limit) break;
      if (o[0].toLowerCase() !== this.io.account.address.toLowerCase()) units += o[3];
      id = o[7];
    }
    return units;
  }

  private async quotePool(pid: Hex, cls: PoolClass, now: number): Promise<void> {
    const { pub, wallet, account } = this.io;
    const v = await this.poolView(pid);
    if (v.status !== Status.Open || now >= Number(v.key.expiry)) return;
    const next = await pub.readContract({ address: this.core, abi: confluereAbi, functionName: "nextBatchAt", args: [pid] });
    if (Number(next) - now > this.cfg.leadS || this.lastBatch.get(pid) === next) return;
    const scale = scaleOf(v.assetDecimals);
    const inputs = {
      cls,
      lastClearingPrice: v.lastClearingPrice,
      scale,
      perBatchQuote: this.cfg.perBatch,
      remainingQuote: this.remaining(pid),
      competitiveDepthUnits: 0n,
      now,
      endAt: this.cfg.endAt,
    };
    const draft = quote(inputs);
    if (!draft) return;
    const depth = await this.depthAtOrAbove(pid, draft.limit);
    const q = quote({ ...inputs, competitiveDepthUnits: depth });
    this.lastBatch.set(pid, next);
    if (!q) return;
    const esc = buyEscrow(q.units, q.limit, 1, scale);
    const allowance = await pub.readContract({ address: v.key.quote, abi: erc20Abi, functionName: "allowance", args: [account.address, this.core] });
    if (allowance < esc) {
      const approve = await wallet.writeContract({
        address: v.key.quote,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.core, maxUint256],
        account,
        chain: wallet.chain,
      });
      await pub.waitForTransactionReceipt({ hash: approve });
    }
    const hint = await pub.readContract({ address: this.core, abi: confluereAbi, functionName: "findHint", args: [pid, Side.Buy, q.limit] });
    const hash = await wallet.writeContract({
      address: this.core,
      abi: confluereAbi,
      functionName: "placeOrder",
      args: [pid, { side: Side.Buy, units: q.units, limit: q.limit, budget: 0n, ttl: 1, hint, owner: account.address }],
      account,
      chain: wallet.chain,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const placed = parseEventLogs({ abi: confluereAbi, eventName: "OrderPlaced", logs: rc.logs }).find(
      (l) => l.args.poolId === pid && l.args.owner.toLowerCase() === account.address.toLowerCase(),
    );
    if (placed) {
      const open = (this.state.open ??= {});
      (open[pid] ??= []).push({ id: placed.args.orderId.toString(), escrow: esc.toString(), block: rc.blockNumber.toString() });
    } else {
      // cannot track the order: count its whole escrow as spent so the cap still holds
      this.state.spent[pid] = (this.spentOf(pid) + esc).toString();
      this.state.untracked = true; // its refund cannot be tied to the order leaving the book: poll pending from now on
    }
    this.save();
    this.log("bootstrap bid", { pool: pid, limit: q.limit, units: q.units, escrow: esc, depth });
  }
}
