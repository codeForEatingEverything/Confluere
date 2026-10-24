//! One pool: order book, batch clearing, repayment window, abandonment auction, close, claim.
//! Mirrors `ClearingLogic.sol` / `WindowLogic.sol` for `Rules::v07()`, and applies the 2026-10-23
//! decisions for `Rules::v08()` (per-fill fees into `fee_escrow`, trade fee, NC buy demand in pricing,
//! rollover fills in the last batch before the old expiry).

use crate::ledger::{Addr, Ledger, TREASURY};
use crate::math::*;
use crate::rules::{FeeRule, PauseRule, PricingRule, Rules};
use std::collections::BTreeMap;

pub const PPM: u128 = 1_000_000;
pub const MAX_TTL: u32 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Sell,
    Buy,
    NcSell,
    NcBuy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Open,
    Window,
    Closed,
}

#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub owner: Addr,
    pub side: Side,
    pub units: u128,
    pub limit: u128,
    pub escrow: u128,
    pub deadline: u32,
    pub alive: bool,
    /// Rollover sell: index of the old pool whose R is locked behind this order.
    pub rollover_old: Option<usize>,
    /// Refreshed by `Market::settle` before each clearing: may this rollover fill now?
    pub rollover_live: bool,
    /// Set by the market when the old pool's window has ended: the order is void and `purge` refunds it.
    pub rollover_void: bool,
    pub rollover_k: u128,
    pub rollover_scale: u128,
    pub rollover_vwap: u128,
}

#[derive(Clone, Debug)]
pub struct Bid {
    pub owner: Addr,
    pub units: u128,
    pub premium_per_unit: u128,
    pub escrow: u128,
}

/// A rollover fill that `Market::settle` must apply to the old pool.
#[derive(Clone, Debug)]
pub struct RolloverFill {
    pub old: usize,
    pub owner: Addr,
    pub units: u128,
    /// K paid into the old pool (before the v0.7 fee).
    pub pay: u128,
    pub fee_v07: u128,
}

#[derive(Clone, Copy, Debug)]
pub struct PoolKey {
    pub strike: u128,
    pub expiry: u64,
    pub american: bool,
    pub band_bps: u128,
    /// 0: every base interval, 1: every 12, 2: every 48.
    pub cadence: u8,
}

#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub anchor: u64,
    pub batch_interval: u64,
    pub window_blocks: u64,
    pub max_pause_blocks: u64,
}

/// What one `settleBatch` did; the scenario runner writes these out.
#[derive(Clone, Debug, Default)]
pub struct BatchReport {
    pub settle_index: u32,
    pub traded: bool,
    pub price: u128,
    pub competitive_units: u128,
    pub nc_buy_units_in_pricing: u128,
    pub nc_units: u128,
    pub spread_fee: u128,
    pub trade_fee: u128,
    pub band_allowed_nc: bool,
    pub band_failures: u32,
    /// Why nothing traded: "", "no_cross", "min_fill", "first_bounds", "competitive_band".
    pub no_trade_reason: &'static str,
}

#[derive(Clone, Debug)]
pub struct Fill {
    pub settle_index: u32,
    pub order_id: u64,
    pub owner: Addr,
    pub side: Side,
    pub units: u128,
    pub price: u128,
}

#[derive(Clone, Debug)]
pub struct Pool {
    pub key: PoolKey,
    pub grid: Grid,
    pub status: Status,
    pub scale: u128,
    pub fee_bps_v07: u128,
    pub auto_sell: bool,
    /// Creator options (blueprint §4 long-tail pools).
    pub min_fill: u128,
    pub first_lo: u128,
    pub first_hi: u128,
    orders: Vec<Order>,
    next_id: u64,
    pub settle_count: u32,
    pub last_settled_batch: u64,
    pub quote_bal: u128,
    pub asset_bal: u128,
    pub surplus_bal: u128,
    pub fee_escrow: u128,
    pub repaid_units: u128,
    pub total_units: u128,
    pub r_supply: u128,
    pub c_supply: u128,
    sum_pu: u128,
    sum_units: u128,
    pub last_clearing_price: u128,
    pub band_base: u128,
    pub band_failures: u32,
    pub bad: bool,
    pub window_end: Option<u64>,
    pub bids: Vec<Bid>,
    pub c_bal: BTreeMap<Addr, u128>,
    pub r_bal: BTreeMap<Addr, u128>,
    pub locked_r: BTreeMap<Addr, u128>,
    pub paused_until: u64,
    pub paused_total: u64,
    pub ever_paused: bool,
    /// Cumulative quote the treasury received from this pool (all fee kinds).
    pub fees_to_treasury: u128,
    pub fills: Vec<Fill>,
    pub reports: Vec<BatchReport>,
    /// Rollover fills of the last `settle`, consumed by `Market::settle`.
    pub rollover_fills: Vec<RolloverFill>,
    /// Variant A: per-settlement tranches (active once a fill happened under `Rules::tranche_c`).
    pub tranche_mode: bool,
    pub tranches: BTreeMap<u32, Tranche>,
    pub c_t: BTreeMap<(Addr, u32), u128>,
    pub r_t: BTreeMap<(Addr, u32), u128>,
}

/// One settlement batch's own sub-ledger under the tranche variant.
#[derive(Clone, Debug, Default)]
pub struct Tranche {
    pub units: u128,
    pub c_left: u128,
    pub quote: u128,
    pub asset: u128,
    pub unrepaid: u128,
    pub escrow: u128,
}

impl Pool {
    pub fn new(key: PoolKey, grid: Grid, asset_decimals: u32, now_ts: u64) -> Self {
        let iv = Self::interval_of(&key, &grid);
        Pool {
            key,
            grid,
            status: Status::Open,
            scale: 10u128.pow(asset_decimals),
            fee_bps_v07: 1000,
            auto_sell: false,
            min_fill: 0,
            first_lo: 0,
            first_hi: 0,
            orders: Vec::new(),
            next_id: 1,
            settle_count: 0,
            last_settled_batch: (now_ts - grid.anchor) / iv,
            quote_bal: 0,
            asset_bal: 0,
            surplus_bal: 0,
            fee_escrow: 0,
            repaid_units: 0,
            total_units: 0,
            r_supply: 0,
            c_supply: 0,
            sum_pu: 0,
            sum_units: 0,
            last_clearing_price: 0,
            band_base: 0,
            band_failures: 0,
            bad: false,
            window_end: None,
            bids: Vec::new(),
            c_bal: BTreeMap::new(),
            r_bal: BTreeMap::new(),
            locked_r: BTreeMap::new(),
            paused_until: 0,
            paused_total: 0,
            ever_paused: false,
            fees_to_treasury: 0,
            fills: Vec::new(),
            reports: Vec::new(),
            rollover_fills: Vec::new(),
            tranche_mode: false,
            tranches: BTreeMap::new(),
            c_t: BTreeMap::new(),
            r_t: BTreeMap::new(),
        }
    }

    /// Variant A bookkeeping for a repayment of `units` by `owner`, oldest tranche first; `net` is the quote
    /// that stays in the pool for C holders.
    fn tranche_repay(&mut self, owner: Addr, units: u128, net: u128) {
        if !self.tranche_mode {
            return;
        }
        let mut left = units;
        let mut quote_left = net;
        let keys: Vec<u32> = self
            .r_t
            .keys()
            .filter(|(a, _)| *a == owner)
            .map(|(_, t)| *t)
            .collect();
        for (i, t) in keys.iter().enumerate() {
            if left == 0 {
                break;
            }
            let have = *self.r_t.get(&(owner, *t)).unwrap_or(&0);
            let f = have.min(left);
            if f == 0 {
                continue;
            }
            left -= f;
            let q = if i + 1 == keys.len() || left == 0 {
                quote_left
            } else {
                mul_div(net, f, units)
            };
            quote_left -= q;
            let tr = self.tranches.get_mut(t).unwrap();
            tr.unrepaid -= f;
            tr.asset -= f;
            tr.quote += q;
            *self.r_t.get_mut(&(owner, *t)).unwrap() -= f;
        }
        debug_assert!(left == 0, "tranche repay exceeds R");
    }

    /// Σ tranche balances equal the pool balances (variant A consistency).
    pub fn tranche_consistent(&self) -> bool {
        if !self.tranche_mode {
            return true;
        }
        let q: u128 = self.tranches.values().map(|t| t.quote).sum();
        let a: u128 = self.tranches.values().map(|t| t.asset).sum();
        let u: u128 = self.tranches.values().map(|t| t.unrepaid).sum();
        q == self.quote_bal
            && a == self.asset_bal
            && (self.status == Status::Closed || u == self.r_supply)
    }

    fn interval_of(key: &PoolKey, grid: &Grid) -> u64 {
        grid.batch_interval
            * match key.cadence {
                0 => 1,
                1 => 12,
                _ => 48,
            }
    }
    pub fn interval(&self) -> u64 {
        Self::interval_of(&self.key, &self.grid)
    }
    pub fn next_batch_at(&self) -> u64 {
        self.grid.anchor + (self.last_settled_batch + 1) * self.interval()
    }
    pub fn vwap(&self) -> u128 {
        if self.sum_units == 0 {
            0
        } else {
            self.sum_pu / self.sum_units
        }
    }
    pub fn order(&self, id: u64) -> Option<&Order> {
        self.orders.iter().find(|o| o.id == id && o.alive)
    }
    pub fn live_orders(&self) -> impl Iterator<Item = &Order> {
        self.orders.iter().filter(|o| o.alive)
    }
    pub fn rollover_orders_mut(&mut self) -> impl Iterator<Item = &mut Order> {
        self.orders
            .iter_mut()
            .filter(|o| o.alive && o.rollover_old.is_some())
    }
    pub fn escrowed_quote(&self) -> u128 {
        self.live_orders().map(|o| o.escrow).sum::<u128>()
            + self.bids.iter().map(|b| b.escrow).sum::<u128>()
    }
    /// Asset escrowed by plain sell orders (rollover sells leave the asset in the old pool).
    pub fn escrowed_asset(&self) -> u128 {
        self.live_orders()
            .filter(|o| matches!(o.side, Side::Sell | Side::NcSell) && o.rollover_old.is_none())
            .map(|o| o.units)
            .sum()
    }
    pub fn c_of(&self, a: Addr) -> u128 {
        *self.c_bal.get(&a).unwrap_or(&0)
    }
    pub fn r_of(&self, a: Addr) -> u128 {
        *self.r_bal.get(&a).unwrap_or(&0)
    }
    pub fn free_r(&self, a: Addr) -> u128 {
        self.r_of(a) - *self.locked_r.get(&a).unwrap_or(&0)
    }

    /// C is transferable (ERC-6909).
    pub fn transfer_c(&mut self, from: Addr, to: Addr, units: u128) -> Result<(), String> {
        if self.tranche_mode {
            return Err("tranche variant: transfer C per batch id (not modelled)".into());
        }
        if self.c_of(from) < units {
            return Err("not enough C".into());
        }
        *self.c_bal.get_mut(&from).unwrap() -= units;
        *self.c_bal.entry(to).or_default() += units;
        Ok(())
    }
    pub fn transfer_r(&mut self, from: Addr, to: Addr, units: u128) -> Result<(), String> {
        if self.free_r(from) < units {
            return Err("not enough free R".into());
        }
        *self.r_bal.get_mut(&from).unwrap() -= units;
        *self.r_bal.entry(to).or_default() += units;
        Ok(())
    }

    // ------------------------------------------------------------------ orders

    /// Buy-order escrow at placement. v0.8 reserves the buyer's 0.015% trade fee on top.
    pub fn buy_escrow(&self, rules: &Rules, units: u128, limit: u128, ttl: u32) -> u128 {
        let base = quote_up(units, limit, self.scale);
        let fee = match rules.fee {
            FeeRule::PerFillEscrow {
                trade_ppm_each_side,
                ..
            } => mul_div_up(base, trade_ppm_each_side, PPM),
            _ => 0,
        };
        base + fee + ttl as u128
    }

    fn blank_order(&self, owner: Addr, side: Side, units: u128, limit: u128, ttl: u32) -> Order {
        Order {
            id: self.next_id,
            owner,
            side,
            units,
            limit,
            escrow: 0,
            deadline: self.settle_count + ttl,
            alive: true,
            rollover_old: None,
            rollover_live: false,
            rollover_void: false,
            rollover_k: 0,
            rollover_scale: 0,
            rollover_vwap: 0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn place(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        owner: Addr,
        side: Side,
        units: u128,
        limit: u128,
        budget: u128,
        ttl: u32,
    ) -> Result<u64, String> {
        self.place_at(rules, l, owner, side, units, limit, budget, ttl, 0)
    }

    /// `placeOrder` with the current block (a paused pool refuses new orders).
    #[allow(clippy::too_many_arguments)]
    pub fn place_at(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        owner: Addr,
        side: Side,
        units: u128,
        limit: u128,
        budget: u128,
        ttl: u32,
        block: u64,
    ) -> Result<u64, String> {
        if self.status != Status::Open {
            return Err("pool not open".into());
        }
        if self.is_paused(block) {
            return Err("paused".into());
        }
        if ttl == 0 || ttl > MAX_TTL {
            return Err("bad ttl".into());
        }
        let mut o = self.blank_order(owner, side, units, limit, ttl);
        match side {
            Side::Sell => {
                if units == 0 || limit == 0 {
                    return Err("bad sell".into());
                }
                l.pull_asset(owner, units)?;
            }
            Side::NcSell => {
                if units == 0 {
                    return Err("bad nc sell".into());
                }
                l.pull_asset(owner, units)?;
            }
            Side::Buy => {
                if units == 0 || limit == 0 {
                    return Err("bad buy".into());
                }
                o.escrow = self.buy_escrow(rules, units, limit, ttl);
                l.pull_quote(owner, o.escrow)?;
            }
            Side::NcBuy => {
                if budget == 0 {
                    return Err("bad nc buy".into());
                }
                o.units = 0;
                o.escrow = budget;
                l.pull_quote(owner, budget)?;
            }
        }
        self.next_id += 1;
        let id = o.id;
        self.orders.push(o);
        Ok(id)
    }

    /// Rollover sell into this (new) pool; the asset stays in the old pool, `max_top_up` quote is escrowed.
    /// The caller (`Market::rollover`) has locked the R in the old pool.
    #[allow(clippy::too_many_arguments)]
    pub fn place_rollover(
        &mut self,
        l: &mut Ledger,
        owner: Addr,
        units: u128,
        min_price: u128,
        max_top_up: u128,
        ttl: u32,
        old: usize,
        old_k: u128,
        old_scale: u128,
    ) -> Result<u64, String> {
        if self.status != Status::Open {
            return Err("new pool not open".into());
        }
        if units == 0 || min_price == 0 || ttl == 0 || ttl > MAX_TTL {
            return Err("bad rollover".into());
        }
        let need = if old_k > min_price {
            quote_up(units, old_k - min_price, old_scale)
        } else {
            0
        } + 2 * ttl as u128;
        if max_top_up < need {
            return Err(format!("top-up {max_top_up} < needed {need}"));
        }
        l.pull_quote(owner, max_top_up)?;
        let mut o = self.blank_order(owner, Side::Sell, units, min_price, ttl);
        o.escrow = max_top_up;
        o.rollover_old = Some(old);
        o.rollover_k = old_k;
        o.rollover_scale = old_scale;
        self.next_id += 1;
        let id = o.id;
        self.orders.push(o);
        Ok(id)
    }

    /// Cancel. Returns the (old pool, units) to unlock when the order was a rollover.
    pub fn cancel(
        &mut self,
        l: &mut Ledger,
        owner: Addr,
        id: u64,
    ) -> Result<Option<(usize, u128)>, String> {
        let idx = self
            .orders
            .iter()
            .position(|o| o.id == id && o.alive)
            .ok_or("no such order")?;
        if self.orders[idx].owner != owner {
            return Err("not owner".into());
        }
        let unlock = self.orders[idx]
            .rollover_old
            .map(|old| (old, self.orders[idx].units));
        self.remove_with_refund(l, idx);
        Ok(unlock)
    }

    fn remove_with_refund(&mut self, l: &mut Ledger, idx: usize) {
        let o = &mut self.orders[idx];
        o.alive = false;
        match o.side {
            Side::Sell | Side::NcSell => {
                if o.rollover_old.is_some() {
                    if o.escrow != 0 {
                        l.credit_quote(o.owner, o.escrow);
                    }
                } else if o.units != 0 {
                    l.credit_asset(o.owner, o.units);
                }
            }
            Side::Buy | Side::NcBuy => {
                if o.escrow != 0 {
                    l.credit_quote(o.owner, o.escrow);
                }
            }
        }
        o.units = 0;
        o.escrow = 0;
    }

    /// Permissionless clean-up of orders that can no longer trade (ttl spent, trading over, void rollovers).
    /// Returns the (old pool, units) pairs whose R must be unlocked.
    pub fn purge(&mut self, l: &mut Ledger) -> Vec<(usize, u128)> {
        let sc = self.settle_count;
        let trading_over = self.status != Status::Open;
        let idxs: Vec<usize> = self
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| o.alive && (o.deadline <= sc || trading_over || o.rollover_void))
            .map(|(i, _)| i)
            .collect();
        let mut unlock = Vec::new();
        for i in idxs {
            if let Some(old) = self.orders[i].rollover_old {
                unlock.push((old, self.orders[i].units));
            }
            self.remove_with_refund(l, i);
        }
        unlock
    }

    /// Refund rollover orders whose old pool's window has ended; returns (old pool, units) to unlock.
    pub fn purge_void(&mut self, l: &mut Ledger) -> Vec<(usize, u128)> {
        let idxs: Vec<usize> = self
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| o.alive && o.rollover_void)
            .map(|(i, _)| i)
            .collect();
        let mut unlock = Vec::new();
        for i in idxs {
            unlock.push((self.orders[i].rollover_old.unwrap(), self.orders[i].units));
            self.remove_with_refund(l, i);
        }
        unlock
    }

    // ------------------------------------------------------------------ guardian

    pub fn pause(&mut self, rules: &Rules, block: u64, blocks: u64) -> Result<(), String> {
        if blocks == 0 || blocks > self.grid.max_pause_blocks {
            return Err("blocks out of range".into());
        }
        match rules.pause {
            PauseRule::PerPause => {}
            PauseRule::Cumulative => {
                if block < self.paused_until {
                    return Err("already paused".into());
                }
                if self.paused_total + blocks > self.grid.max_pause_blocks {
                    return Err("cumulative pause cap".into());
                }
            }
        }
        self.paused_until = block + blocks;
        self.paused_total += blocks;
        self.ever_paused = true;
        self.bad = true;
        Ok(())
    }

    pub fn is_paused(&self, block: u64) -> bool {
        block < self.paused_until
    }

    // ------------------------------------------------------------------ clearing

    fn nc_eligible(&self, o: &Order, price: u128) -> bool {
        match o.side {
            Side::NcBuy => price < self.key.strike && (o.limit == 0 || price <= o.limit),
            Side::NcSell => o.limit == 0 || price >= o.limit,
            _ => false,
        }
    }

    /// Live orders of a side in book order, including ones whose ttl is spent (the contract leaves those in
    /// the book until a settlement walks past them or `purge` removes them).
    fn sorted_side_all(&self, side: Side) -> Vec<usize> {
        let mut v: Vec<usize> = self
            .orders
            .iter()
            .enumerate()
            .filter(|(_, o)| o.alive && o.side == side)
            .map(|(i, _)| i)
            .collect();
        match side {
            Side::Sell => v.sort_by_key(|&i| (self.orders[i].limit, self.orders[i].id)),
            Side::Buy => v.sort_by_key(|&i| (u128::MAX - self.orders[i].limit, self.orders[i].id)),
            _ => v.sort_by_key(|&i| self.orders[i].id),
        }
        v
    }

    fn order_live(&self, i: usize, sc: u32) -> bool {
        let o = &self.orders[i];
        o.deadline > sc && (o.rollover_old.is_none() || o.rollover_live)
    }

    fn sorted_side(&self, side: Side, sc: u32) -> Vec<usize> {
        self.sorted_side_all(side)
            .into_iter()
            .filter(|&i| self.order_live(i, sc))
            .collect()
    }

    /// Pass 1 with an optional "any price" demand block of `extra_demand` units at the top of the buy book.
    /// Returns (competitive crossing volume, marginal sell limit, marginal buy limit, sells consumed by extra).
    fn cross(
        &self,
        sells: &[usize],
        buys: &[usize],
        extra_demand: u128,
    ) -> (u128, u128, u128, u128) {
        let mut qc = 0u128;
        let mut last_s = 0u128;
        let mut last_b = 0u128;
        let mut extra = extra_demand;
        let mut si = 0usize;
        let mut srem = sells.first().map(|&i| self.orders[i].units).unwrap_or(0);
        while extra != 0 && si < sells.len() {
            let m = srem.min(extra);
            extra -= m;
            srem -= m;
            if srem == 0 {
                si += 1;
                srem = sells.get(si).map(|&i| self.orders[i].units).unwrap_or(0);
            }
        }
        let consumed_by_extra = extra_demand - extra;
        let mut bi = 0usize;
        let mut brem = buys.first().map(|&i| self.orders[i].units).unwrap_or(0);
        while si < sells.len() && bi < buys.len() {
            let sl = self.orders[sells[si]].limit;
            let bl = self.orders[buys[bi]].limit;
            if sl > bl {
                break;
            }
            let m = srem.min(brem);
            qc += m;
            last_s = sl;
            last_b = bl;
            srem -= m;
            brem -= m;
            if srem == 0 {
                si += 1;
                srem = sells.get(si).map(|&i| self.orders[i].units).unwrap_or(0);
            }
            if brem == 0 {
                bi += 1;
                brem = buys.get(bi).map(|&i| self.orders[i].units).unwrap_or(0);
            }
        }
        (qc, last_s, last_b, consumed_by_extra)
    }

    /// Band check with state update, as `_bandAllowsNc`.
    fn band_allows_nc(&mut self, rules: &Rules, price: u128) -> bool {
        let base = self.band_base;
        let f = self.band_failures;
        if base == 0 || f >= rules.breaker_failures {
            self.band_base = price;
            self.band_failures = 0;
            return false;
        }
        if within_band(price, base, widened_band(self.key.band_bps, f)) {
            self.band_base = price;
            self.band_failures = 0;
            return true;
        }
        self.band_failures = f + 1;
        if self.band_failures >= rules.breaker_failures {
            self.bad = true;
        }
        false
    }

    fn drop_expired_heads(&mut self, l: &mut Ledger, sc: u32) {
        for side in [Side::Sell, Side::Buy, Side::NcSell, Side::NcBuy] {
            for i in self.sorted_side_all(side) {
                if self.orders[i].deadline <= sc {
                    self.remove_with_refund(l, i);
                } else {
                    break;
                }
            }
        }
    }

    fn no_trade(&mut self, mut rep: BatchReport, reason: &'static str) -> BatchReport {
        rep.no_trade_reason = reason;
        rep.band_failures = self.band_failures;
        self.reports.push(rep.clone());
        rep
    }

    /// `settleBatch`. Call once the batch boundary has passed. Rollover fills are left in `rollover_fills`.
    pub fn settle(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        ts: u64,
        block: u64,
    ) -> Result<BatchReport, String> {
        if self.status != Status::Open {
            return Err("not trading".into());
        }
        if self.is_paused(block) {
            return Err("paused".into());
        }
        let batch_index = (ts - self.grid.anchor) / self.interval();
        if batch_index <= self.last_settled_batch {
            return Err("batch not ready".into());
        }
        self.last_settled_batch = batch_index;
        let sc = self.settle_count;
        self.settle_count += 1;
        self.rollover_fills.clear();
        let mut rep = BatchReport {
            settle_index: sc,
            ..Default::default()
        };

        self.drop_expired_heads(l, sc);

        let sells = self.sorted_side(Side::Sell, sc);
        let buys = self.sorted_side(Side::Buy, sc);
        let nc_sells = self.sorted_side(Side::NcSell, sc);
        let nc_buys = self.sorted_side(Side::NcBuy, sc);

        let (mut qc, mut ls, mut lb, _) = self.cross(&sells, &buys, 0);
        if qc == 0 {
            return Ok(self.no_trade(rep, "no_cross"));
        }
        let mut price = midpoint(ls, lb);
        let mut nc_in_pricing = 0u128;

        // v0.8: non-competitive buy budgets join the demand curve, capped at 50% of the competitive volume.
        if rules.pricing == PricingRule::NcBuyInDemand {
            let band_ok_preview = self.band_base != 0
                && self.band_failures < rules.breaker_failures
                && within_band(
                    price,
                    self.band_base,
                    widened_band(self.key.band_bps, self.band_failures),
                );
            if band_ok_preview {
                let mut demand = 0u128;
                for _ in 0..16 {
                    let cap = qc * rules.nc_share_bps / BPS;
                    let budget: u128 = nc_buys
                        .iter()
                        .map(|&i| &self.orders[i])
                        .filter(|o| self.nc_eligible(o, price))
                        .map(|o| units_for(o.escrow, price, self.scale))
                        .sum();
                    let want = budget.min(cap);
                    if want == demand {
                        break;
                    }
                    let (q2, s2, b2, consumed) = self.cross(&sells, &buys, want);
                    if q2 == 0 {
                        break;
                    }
                    demand = consumed.min(q2 * rules.nc_share_bps / BPS);
                    qc = q2;
                    ls = s2;
                    lb = b2;
                    price = midpoint(ls, lb);
                    if demand == want {
                        break;
                    }
                }
                if price >= self.key.strike
                    || !within_band(
                        price,
                        self.band_base,
                        widened_band(self.key.band_bps, self.band_failures),
                    )
                {
                    let (q0, s0, b0, _) = self.cross(&sells, &buys, 0);
                    qc = q0;
                    ls = s0;
                    lb = b0;
                    price = midpoint(ls, lb);
                    demand = 0;
                }
                nc_in_pricing = demand;
            }
        }

        // Creator options: minimum fill and first-auction bounds (blueprint §4 long-tail pools).
        if qc < self.min_fill {
            return Ok(self.no_trade(rep, "min_fill"));
        }
        if self.sum_units == 0
            && (price < self.first_lo || (self.first_hi != 0 && price > self.first_hi))
        {
            return Ok(self.no_trade(rep, "first_bounds"));
        }
        // Variant B of the dilution fix: competitive clearing itself must stay inside the widened band.
        if rules.competitive_band
            && self.band_base != 0
            && !within_band(
                price,
                self.band_base,
                widened_band(self.key.band_bps, self.band_failures),
            )
        {
            self.band_failures += 1;
            if self.band_failures >= rules.breaker_failures {
                self.band_base = 0;
                self.band_failures = 0;
                self.bad = true;
            }
            return Ok(self.no_trade(rep, "competitive_band"));
        }

        self.last_clearing_price = price;
        let band_ok = self.band_allows_nc(rules, price);
        rep.band_allowed_nc = band_ok;
        rep.band_failures = self.band_failures;

        // Stage 2: non-competitive leftovers at P*, capped at 50% of competitive volume (minus what already priced).
        let cap = (qc * rules.nc_share_bps / BPS).saturating_sub(nc_in_pricing);
        let (mut sell_nc, mut sell_c2, mut buy_nc, mut buy_c2) = (0u128, 0u128, 0u128, 0u128);
        if band_ok && cap != 0 {
            let nc_s: u128 = nc_sells
                .iter()
                .map(|&i| &self.orders[i])
                .filter(|o| self.nc_eligible(o, price))
                .map(|o| o.units)
                .sum();
            let nc_b_total: u128 = nc_buys
                .iter()
                .map(|&i| &self.orders[i])
                .filter(|o| self.nc_eligible(o, price))
                .map(|o| units_for(o.escrow, price, self.scale))
                .sum();
            let nc_b = nc_b_total.saturating_sub(nc_in_pricing);
            let sell_total_willing: u128 = sells
                .iter()
                .map(|&i| &self.orders[i])
                .filter(|o| o.limit <= price)
                .map(|o| o.units)
                .sum();
            let buy_total_willing: u128 = buys
                .iter()
                .map(|&i| &self.orders[i])
                .filter(|o| o.limit >= price)
                .map(|o| o.units)
                .sum();
            let c_sl = sell_total_willing
                .saturating_sub(qc + nc_in_pricing)
                .min(cap);
            let c_bl = if c_sl != 0 {
                0
            } else {
                buy_total_willing.saturating_sub(qc).min(cap)
            };
            let mut m2 = nc_s + c_sl;
            if nc_b + c_bl < m2 {
                m2 = nc_b + c_bl;
            }
            if cap < m2 {
                m2 = cap;
            }
            sell_nc = nc_s.min(m2);
            sell_c2 = m2 - sell_nc;
            buy_nc = nc_b.min(m2);
            buy_c2 = m2 - buy_nc;
        }

        let mut paid = 0u128;
        let mut received = 0u128;
        let mut spread_fee = 0u128;
        let mut trade_fee = 0u128;
        let sell_target = qc + nc_in_pricing + sell_c2;
        let buy_target = qc + buy_c2;
        let (sells, buys, nc_sells, nc_buys) = (
            self.sorted_side_all(Side::Sell),
            self.sorted_side_all(Side::Buy),
            self.sorted_side_all(Side::NcSell),
            self.sorted_side_all(Side::NcBuy),
        );
        self.fill_sorted(
            rules,
            l,
            &sells,
            sell_target,
            price,
            sc,
            &mut received,
            &mut spread_fee,
            &mut trade_fee,
        );
        self.fill_sorted(
            rules,
            l,
            &buys,
            buy_target,
            price,
            sc,
            &mut paid,
            &mut spread_fee,
            &mut trade_fee,
        );
        if sell_nc != 0 {
            self.fill_queue(
                rules,
                l,
                &nc_sells,
                sell_nc,
                price,
                sc,
                &mut received,
                &mut spread_fee,
                &mut trade_fee,
            );
        }
        let nc_buy_target = nc_in_pricing + buy_nc;
        if nc_buy_target != 0 {
            self.fill_queue(
                rules,
                l,
                &nc_buys,
                nc_buy_target,
                price,
                sc,
                &mut paid,
                &mut spread_fee,
                &mut trade_fee,
            );
        }
        let total = qc + nc_in_pricing + sell_nc + sell_c2;
        self.quote_bal += paid - received;
        if self.tranche_mode {
            let tr = self.tranches.entry(sc).or_default();
            tr.quote += paid - received;
            tr.escrow += spread_fee;
        }
        self.fee_escrow += spread_fee;
        if trade_fee != 0 {
            l.credit_quote(TREASURY, trade_fee);
            self.fees_to_treasury += trade_fee;
        }
        self.sum_pu += price * total;
        self.sum_units += total;
        self.total_units += total;

        rep.traded = true;
        rep.price = price;
        rep.competitive_units = qc;
        rep.nc_buy_units_in_pricing = nc_in_pricing;
        rep.nc_units = total - qc;
        rep.spread_fee = spread_fee;
        rep.trade_fee = trade_fee;
        self.reports.push(rep.clone());
        Ok(rep)
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_sorted(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        idxs: &[usize],
        mut target: u128,
        price: u128,
        sc: u32,
        flow: &mut u128,
        spread_fee: &mut u128,
        trade_fee: &mut u128,
    ) {
        for &i in idxs {
            if target == 0 {
                break;
            }
            if !self.orders[i].alive {
                continue;
            }
            if self.orders[i].deadline <= sc {
                self.remove_with_refund(l, i);
                continue;
            }
            if !self.order_live(i, sc) {
                continue;
            }
            let f = self.orders[i].units.min(target);
            target -= f;
            self.fill_one(rules, l, i, f, price, sc, flow, spread_fee, trade_fee);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_queue(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        idxs: &[usize],
        mut target: u128,
        price: u128,
        sc: u32,
        flow: &mut u128,
        spread_fee: &mut u128,
        trade_fee: &mut u128,
    ) {
        for &i in idxs {
            if target == 0 {
                break;
            }
            if !self.orders[i].alive {
                continue;
            }
            if self.orders[i].deadline <= sc {
                self.remove_with_refund(l, i);
                continue;
            }
            if !self.nc_eligible(&self.orders[i], price) {
                continue;
            }
            let avail = match self.orders[i].side {
                Side::NcSell => self.orders[i].units,
                _ => {
                    let esc = self.orders[i].escrow;
                    let gross = match rules.fee {
                        FeeRule::PerFillEscrow {
                            trade_ppm_each_side,
                            ..
                        } => mul_div(esc, PPM, PPM + trade_ppm_each_side),
                        _ => esc,
                    };
                    units_for(gross, price, self.scale)
                }
            };
            let f = avail.min(target);
            if f == 0 {
                continue;
            }
            target -= f;
            self.fill_one(rules, l, i, f, price, sc, flow, spread_fee, trade_fee);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn fill_one(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        i: usize,
        f: u128,
        price: u128,
        sc: u32,
        flow: &mut u128,
        spread_fee: &mut u128,
        trade_fee: &mut u128,
    ) {
        let side = self.orders[i].side;
        let owner = self.orders[i].owner;
        let id = self.orders[i].id;
        self.fills.push(Fill {
            settle_index: sc,
            order_id: id,
            owner,
            side,
            units: f,
            price,
        });
        match side {
            Side::Sell | Side::NcSell => {
                let proceeds = quote_down(f, price, self.scale);
                *flow += proceeds;
                self.asset_bal += f;
                let mut net = proceeds;
                if let FeeRule::PerFillEscrow {
                    spread_bps,
                    trade_ppm_each_side,
                } = rules.fee
                {
                    let sf = if price < self.key.strike {
                        mul_div(
                            mul_div(f, self.key.strike - price, self.scale),
                            spread_bps,
                            BPS,
                        )
                    } else {
                        0
                    };
                    let tf = mul_div(proceeds, trade_ppm_each_side, PPM);
                    let total = (sf + tf).min(proceeds);
                    net = proceeds - total;
                    *spread_fee += sf.min(proceeds);
                    *trade_fee += total - sf.min(proceeds);
                }
                if let Some(old) = self.orders[i].rollover_old {
                    // New-pool proceeds pay K into the old pool; the pre-funded top-up covers any gap.
                    let rk = self.orders[i].rollover_k;
                    let rs = self.orders[i].rollover_scale;
                    let pay = repay_amount(f, rk, rs);
                    let fee07 = match rules.fee {
                        FeeRule::VwapOnRepay { fee_bps } => {
                            fee_v07(f, rk, self.orders[i].rollover_vwap, fee_bps, rs)
                        }
                        _ => 0,
                    };
                    if net >= pay {
                        l.credit_quote(owner, net - pay);
                    } else {
                        let top_up = pay - net;
                        self.orders[i].escrow -= top_up;
                    }
                    self.rollover_fills.push(RolloverFill {
                        old,
                        owner,
                        units: f,
                        pay,
                        fee_v07: fee07,
                    });
                } else {
                    l.credit_quote(owner, net);
                }
                *self.r_bal.entry(owner).or_default() += f;
                self.r_supply += f;
                if rules.tranche_c {
                    self.tranche_mode = true;
                    *self.r_t.entry((owner, sc)).or_default() += f;
                    let tr = self.tranches.entry(sc).or_default();
                    tr.unrepaid += f;
                    tr.asset += f;
                }
                let o = &mut self.orders[i];
                o.units -= f;
                if o.units == 0 {
                    self.remove_with_refund(l, i);
                }
            }
            Side::Buy | Side::NcBuy => {
                let cost = quote_up(f, price, self.scale);
                *flow += cost;
                let tf = match rules.fee {
                    FeeRule::PerFillEscrow {
                        trade_ppm_each_side,
                        ..
                    } => mul_div_up(cost, trade_ppm_each_side, PPM),
                    _ => 0,
                };
                *trade_fee += tf;
                *self.c_bal.entry(owner).or_default() += f;
                self.c_supply += f;
                if rules.tranche_c {
                    self.tranche_mode = true;
                    *self.c_t.entry((owner, sc)).or_default() += f;
                    let tr = self.tranches.entry(sc).or_default();
                    tr.units += f;
                    tr.c_left += f;
                }
                let scale = self.scale;
                let o = &mut self.orders[i];
                let esc = o.escrow - cost - tf;
                if o.side == Side::Buy {
                    let rem = o.units - f;
                    if rem == 0 {
                        o.units = 0;
                        o.escrow = esc;
                        self.remove_with_refund(l, i);
                        return;
                    }
                    let left = if o.deadline > sc + 1 {
                        (o.deadline - sc - 1) as u128
                    } else {
                        0
                    };
                    let base = quote_up(rem, o.limit, scale);
                    let fee_res = match rules.fee {
                        FeeRule::PerFillEscrow {
                            trade_ppm_each_side,
                            ..
                        } => mul_div_up(base, trade_ppm_each_side, PPM),
                        _ => 0,
                    };
                    let req = base + fee_res + left;
                    let mut esc2 = esc;
                    if esc2 > req {
                        l.credit_quote(owner, esc2 - req);
                        esc2 = req;
                    }
                    o.units = rem;
                    o.escrow = esc2;
                } else {
                    o.escrow = esc;
                    if esc == 0 {
                        self.remove_with_refund(l, i);
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ window

    /// `mature`: first call of the expiry starts the shared window; pass the shared `window_end` if known.
    pub fn mature(
        &mut self,
        ts: u64,
        block: u64,
        shared_window_end: Option<u64>,
    ) -> Result<u64, String> {
        if self.status != Status::Open || ts < self.key.expiry {
            return Err("not expired".into());
        }
        let end = shared_window_end.unwrap_or(block + self.grid.window_blocks);
        self.status = Status::Window;
        self.window_end = Some(end);
        Ok(end)
    }

    /// `windowOpen` plus the American early-repay path.
    pub fn can_repay(&self, ts: u64, block: u64, shared_window_end: Option<u64>) -> bool {
        match self.status {
            Status::Open if ts < self.key.expiry => self.key.american,
            Status::Open => shared_window_end.map(|e| block < e).unwrap_or(true),
            Status::Window => block < self.window_end.unwrap_or(0),
            Status::Closed => false,
        }
    }

    /// `repay` for scenarios that do not track time precisely: American before expiry or inside the window.
    pub fn repay(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        owner: Addr,
        units: u128,
        block: u64,
    ) -> Result<u128, String> {
        let ts = if self.status == Status::Window {
            self.key.expiry
        } else {
            self.key.expiry.saturating_sub(1)
        };
        self.repay_at(rules, l, owner, units, ts, block, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn repay_at(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        owner: Addr,
        units: u128,
        ts: u64,
        block: u64,
        shared_window_end: Option<u64>,
    ) -> Result<u128, String> {
        if !self.can_repay(ts, block, shared_window_end) {
            return Err("cannot repay now".into());
        }
        if self.free_r(owner) < units || units == 0 {
            return Err("not enough free R".into());
        }
        let pay = repay_amount(units, self.key.strike, self.scale);
        l.pull_quote(owner, pay)?;
        let fee = match rules.fee {
            FeeRule::VwapOnRepay { fee_bps } => {
                fee_v07(units, self.key.strike, self.vwap(), fee_bps, self.scale)
            }
            FeeRule::PerFillEscrow { .. } => 0,
        };
        if fee != 0 {
            l.credit_quote(TREASURY, fee);
            self.fees_to_treasury += fee;
        }
        self.quote_bal += pay - fee;
        self.asset_bal -= units;
        *self.r_bal.get_mut(&owner).unwrap() -= units;
        self.r_supply -= units;
        self.repaid_units += units;
        self.tranche_repay(owner, units, pay - fee);
        l.push_asset(owner, units);
        Ok(pay)
    }

    /// Applied by `Market::settle` for a rollover fill that paid K into this (old) pool.
    pub fn apply_rollover_repay(&mut self, l: &mut Ledger, rf: &RolloverFill) {
        if rf.fee_v07 != 0 {
            l.credit_quote(TREASURY, rf.fee_v07);
            self.fees_to_treasury += rf.fee_v07;
        }
        self.quote_bal += rf.pay - rf.fee_v07;
        self.asset_bal -= rf.units;
        *self.locked_r.get_mut(&rf.owner).unwrap() -= rf.units;
        *self.r_bal.get_mut(&rf.owner).unwrap() -= rf.units;
        self.r_supply -= rf.units;
        self.repaid_units += rf.units;
        self.tranche_repay(rf.owner, rf.units, rf.pay - rf.fee_v07);
    }

    /// Abandonment auction bid: escrow `K + premium` per unit.
    pub fn bid(
        &mut self,
        l: &mut Ledger,
        owner: Addr,
        units: u128,
        premium_per_unit: u128,
        block: u64,
    ) -> Result<(), String> {
        if self.status != Status::Window || block >= self.window_end.unwrap_or(0) {
            return Err("not in window".into());
        }
        if units == 0 {
            return Err("units".into());
        }
        let escrow = quote_up(units, self.key.strike + premium_per_unit, self.scale);
        l.pull_quote(owner, escrow)?;
        self.bids.push(Bid {
            owner,
            units,
            premium_per_unit,
            escrow,
        });
        Ok(())
    }

    /// `closeWindow`: bids by premium high to low take unrepaid units; the rest defaults to C holders.
    /// v0.8: `fee_escrow × repaid / total` goes to the treasury, the rest stays for C holders.
    /// Returns the (old pool, units) rollover locks to release.
    pub fn close(
        &mut self,
        rules: &Rules,
        l: &mut Ledger,
        block: u64,
    ) -> Result<Vec<(usize, u128)>, String> {
        if self.status != Status::Window || block < self.window_end.unwrap_or(u64::MAX) {
            return Err("window not over".into());
        }
        let mut bids = std::mem::take(&mut self.bids);
        bids.sort_by(|a, b| b.premium_per_unit.cmp(&a.premium_per_unit));
        let mut unrepaid = self.r_supply;
        for b in bids {
            let f = b.units.min(unrepaid);
            unrepaid -= f;
            let k_paid = repay_amount(f, self.key.strike, self.scale);
            let surplus = mul_div(f, b.premium_per_unit, self.scale);
            let used = k_paid + surplus;
            self.quote_bal += k_paid;
            self.surplus_bal += surplus;
            self.asset_bal -= f;
            if self.tranche_mode && f != 0 {
                // the bid takes unrepaid units oldest tranche first and pays K into those tranches
                let mut left = f;
                let mut q_left = k_paid;
                let keys: Vec<u32> = self.tranches.keys().copied().collect();
                for t in keys {
                    if left == 0 {
                        break;
                    }
                    let tr = self.tranches.get_mut(&t).unwrap();
                    let x = tr.unrepaid.min(left);
                    if x == 0 {
                        continue;
                    }
                    left -= x;
                    let q = if left == 0 {
                        q_left
                    } else {
                        mul_div(k_paid, x, f)
                    };
                    q_left -= q;
                    tr.unrepaid -= x;
                    tr.asset -= x;
                    tr.quote += q;
                }
            }
            if f != 0 {
                l.credit_asset(b.owner, f);
            }
            if b.escrow > used {
                l.credit_quote(b.owner, b.escrow - used);
            }
        }
        if let FeeRule::PerFillEscrow { .. } = rules.fee {
            if self.tranche_mode {
                // variant A: each tranche's own escrow splits by that tranche's repaid ratio
                let mut to_treasury = 0u128;
                for tr in self.tranches.values_mut() {
                    let repaid = tr.units - tr.unrepaid.min(tr.units);
                    let t = share(tr.escrow, repaid, tr.units.max(1));
                    to_treasury += t;
                    tr.quote += tr.escrow - t;
                    tr.escrow = 0;
                }
                l.credit_quote(TREASURY, to_treasury);
                self.fees_to_treasury += to_treasury;
                self.quote_bal += self.fee_escrow - to_treasury;
            } else {
                let to_treasury =
                    share(self.fee_escrow, self.repaid_units, self.total_units.max(1));
                l.credit_quote(TREASURY, to_treasury);
                self.fees_to_treasury += to_treasury;
                self.quote_bal += self.fee_escrow - to_treasury;
            }
            self.fee_escrow = 0;
        }
        self.status = Status::Closed;
        self.locked_r.clear();
        Ok(self.purge(l))
    }

    /// `claim`: C holders take quote + defaulted asset pro rata; R holders take their share of bid surplus.
    pub fn claim(&mut self, l: &mut Ledger, owner: Addr) -> Result<(u128, u128), String> {
        if self.status != Status::Closed {
            return Err("not closed".into());
        }
        let c = self.c_of(owner);
        let mut q_out = 0;
        let mut a_out = 0;
        if c != 0 && self.tranche_mode {
            // variant A: each tranche pays out its own quote and defaulted asset
            let keys: Vec<u32> = self
                .c_t
                .keys()
                .filter(|(a, _)| *a == owner)
                .map(|(_, t)| *t)
                .collect();
            for t in keys {
                let ct = self.c_t.remove(&(owner, t)).unwrap_or(0);
                if ct == 0 {
                    continue;
                }
                let tr = self.tranches.get_mut(&t).unwrap();
                let q = share(ct, tr.quote, tr.c_left);
                let a = share(ct, tr.asset, tr.c_left);
                tr.quote -= q;
                tr.asset -= a;
                tr.c_left -= ct;
                q_out += q;
                a_out += a;
            }
            self.quote_bal -= q_out;
            self.asset_bal -= a_out;
            self.c_supply -= c;
            self.c_bal.insert(owner, 0);
        } else if c != 0 {
            q_out = share(c, self.quote_bal, self.c_supply);
            a_out = share(c, self.asset_bal, self.c_supply);
            self.quote_bal -= q_out;
            self.asset_bal -= a_out;
            self.c_supply -= c;
            self.c_bal.insert(owner, 0);
        }
        let r = self.r_of(owner);
        if r != 0 {
            let s = share(r, self.surplus_bal, self.r_supply);
            self.surplus_bal -= s;
            self.r_supply -= r;
            self.r_bal.insert(owner, 0);
            q_out += s;
        }
        if q_out != 0 {
            l.push_quote(owner, q_out);
        }
        if a_out != 0 {
            l.push_asset(owner, a_out);
        }
        Ok((q_out, a_out))
    }

    /// ERC-3156 flash loan of pool-held asset: atomic, 0.05% fee to the treasury (in the loaned token).
    /// `repaid` says whether the borrower's callback returned amount + fee.
    pub fn flash_loan(
        &self,
        l: &mut Ledger,
        borrower: Addr,
        amount: u128,
        repaid: bool,
    ) -> Result<u128, String> {
        if amount == 0 || amount > self.asset_bal {
            return Err("amount".into());
        }
        let fee = amount * 5 / BPS;
        if !repaid {
            return Err("flash failed: not repaid".into());
        }
        l.pull_asset(borrower, fee)?;
        l.credit_asset(TREASURY, fee);
        Ok(fee)
    }
}
