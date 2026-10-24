//! A market = asset/quote/kind. Holds its pools, per-expiry statistics, graduation, vault tier selection,
//! the shared repayment window per expiry and rollover orders between pools.

use crate::ledger::Ledger;
use crate::math::{quote_down, within_band, BPS};
use crate::pool::{BatchReport, Grid, Pool, PoolKey, Side, Status};
use crate::rules::{GradRule, Rules, TierRule};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct ExpiryStats {
    /// Quote traded across all strikes at this expiry.
    pub volume: u128,
    /// Quote traded per strike.
    pub volume_by_strike: BTreeMap<u128, u128>,
    /// Last clearing price per strike.
    pub last_price_by_strike: BTreeMap<u128, u128>,
    /// Fees the treasury actually received from pools of this expiry.
    pub fees_paid: u128,
    /// Paused or circuit breaker tripped.
    pub bad: bool,
    pub closed: bool,
}

impl ExpiryStats {
    /// Market-wide volume-weighted clearing price of the expiry (0 if nothing traded).
    pub fn vwap(&self, scale: u128) -> u128 {
        let (mut pu, mut u) = (0u128, 0u128);
        for (k, v) in &self.volume_by_strike {
            let p = self.last_price_by_strike[k];
            if p != 0 {
                let units = v * scale / p;
                pu += p * units;
                u += units;
            }
        }
        if u == 0 {
            0
        } else {
            pu / u
        }
    }
}

#[derive(Clone, Debug)]
pub struct Market {
    pub grid: Grid,
    pub asset_decimals: u32,
    pub american: bool,
    pub pools: Vec<Pool>,
    pub graduated: bool,
    pub graduated_at: Option<u64>,
    /// Shared window end per expiry, set by the first `mature` of that expiry.
    pub window_ends: BTreeMap<u64, u64>,
}

impl Market {
    pub fn new(grid: Grid, asset_decimals: u32, american: bool) -> Self {
        Market {
            grid,
            asset_decimals,
            american,
            pools: Vec::new(),
            graduated: false,
            graduated_at: None,
            window_ends: BTreeMap::new(),
        }
    }

    pub fn create_pool(
        &mut self,
        expiry: u64,
        strike: u128,
        band_bps: u128,
        cadence: u8,
        now_ts: u64,
    ) -> usize {
        let key = PoolKey {
            strike,
            expiry,
            american: self.american,
            band_bps,
            cadence,
        };
        self.pools
            .push(Pool::new(key, self.grid, self.asset_decimals, now_ts));
        self.pools.len() - 1
    }

    pub fn pool_at(&self, expiry: u64, strike: u128) -> Option<usize> {
        self.pools
            .iter()
            .position(|p| p.key.expiry == expiry && p.key.strike == strike)
    }

    pub fn expiries(&self) -> Vec<u64> {
        let mut v: Vec<u64> = self.pools.iter().map(|p| p.key.expiry).collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    pub fn scale(&self) -> u128 {
        10u128.pow(self.asset_decimals)
    }

    // ------------------------------------------------------------------ lifecycle wrappers

    /// `windowOpen` for a pool index, with the shared window of its expiry.
    pub fn window_open(&self, idx: usize, ts: u64, block: u64) -> bool {
        let p = &self.pools[idx];
        match p.status {
            Status::Window => block < p.window_end.unwrap_or(0),
            Status::Open if ts >= p.key.expiry => self
                .window_ends
                .get(&p.key.expiry)
                .map(|&e| block < e)
                .unwrap_or(true),
            _ => false,
        }
    }

    /// `settleBatch` on pool `idx`, applying rollover fills to their old pools.
    pub fn settle(
        &mut self,
        idx: usize,
        rules: &Rules,
        l: &mut Ledger,
        ts: u64,
        block: u64,
    ) -> Result<BatchReport, String> {
        // Refresh rollover liveness: old window open, or (v0.8) the last new-pool batch before the old expiry.
        let olds: Vec<(usize, bool, bool, u128)> = {
            let newp = &self.pools[idx];
            let new_interval = newp.interval();
            newp.live_orders()
                .filter_map(|o| o.rollover_old)
                .map(|old| {
                    let op = &self.pools[old];
                    let win = self.window_open(old, ts, block);
                    let last_batch = rules.rollover_last_batch
                        && op.status == Status::Open
                        && ts < op.key.expiry
                        && ts + new_interval >= op.key.expiry;
                    let void = op.status == Status::Closed
                        || (op.status == Status::Window && block >= op.window_end.unwrap_or(0))
                        || (op.status == Status::Open
                            && ts >= op.key.expiry
                            && self
                                .window_ends
                                .get(&op.key.expiry)
                                .map(|&e| block >= e)
                                .unwrap_or(false));
                    (old, win || last_batch, void, op.vwap())
                })
                .collect()
        };
        for o in self.pools[idx].rollover_orders_mut() {
            if let Some((_, live, void, vwap)) =
                olds.iter().find(|(old, ..)| Some(*old) == o.rollover_old)
            {
                o.rollover_live = *live && !*void;
                o.rollover_void = *void;
                o.rollover_vwap = *vwap;
            }
        }
        let rep = self.pools[idx].settle(rules, l, ts, block)?;
        let fills = std::mem::take(&mut self.pools[idx].rollover_fills);
        for rf in &fills {
            self.pools[rf.old].apply_rollover_repay(l, rf);
        }
        // Void rollovers are refunded and their R unlocked.
        let unlock = {
            let p = &mut self.pools[idx];
            if p.live_orders().any(|o| o.rollover_void) {
                p.purge_void(l)
            } else {
                Vec::new()
            }
        };
        for (old, units) in unlock {
            self.unlock_r(old, units);
        }
        Ok(rep)
    }

    fn unlock_r(&mut self, old: usize, units: u128) {
        // The lock belongs to the order owner; `purge` only reports totals, so release the first lock big enough.
        let p = &mut self.pools[old];
        if p.status == Status::Closed {
            return;
        }
        for v in p.locked_r.values_mut() {
            if *v >= units {
                *v -= units;
                return;
            }
        }
    }

    /// `rollover(old, new, units, minPrice, maxTopUp, ttl)`.
    #[allow(clippy::too_many_arguments)]
    pub fn rollover(
        &mut self,
        old: usize,
        new: usize,
        l: &mut Ledger,
        owner: u32,
        units: u128,
        min_price: u128,
        max_top_up: u128,
        ttl: u32,
        ts: u64,
        block: u64,
    ) -> Result<u64, String> {
        if self.pools[new].key.expiry <= self.pools[old].key.expiry {
            return Err("new expiry must be later".into());
        }
        let op = &self.pools[old];
        let allowed =
            (op.status == Status::Open && ts < op.key.expiry) || self.window_open(old, ts, block);
        if !allowed {
            return Err("old pool not rollable".into());
        }
        if op.free_r(owner) < units {
            return Err("not enough free R".into());
        }
        let (k, scale) = (op.key.strike, op.scale);
        let id = self.pools[new]
            .place_rollover(l, owner, units, min_price, max_top_up, ttl, old, k, scale)?;
        *self.pools[old].locked_r.entry(owner).or_default() += units;
        Ok(id)
    }

    pub fn cancel(
        &mut self,
        idx: usize,
        l: &mut Ledger,
        owner: u32,
        id: u64,
    ) -> Result<(), String> {
        if let Some((old, units)) = self.pools[idx].cancel(l, owner, id)? {
            *self.pools[old].locked_r.get_mut(&owner).unwrap() -= units;
        }
        Ok(())
    }

    /// `mature` with the shared window per expiry.
    pub fn mature(&mut self, idx: usize, ts: u64, block: u64) -> Result<u64, String> {
        let e = self.pools[idx].key.expiry;
        let shared = self.window_ends.get(&e).copied();
        let end = self.pools[idx].mature(ts, block, shared)?;
        self.window_ends.entry(e).or_insert(end);
        Ok(end)
    }

    pub fn repay(
        &mut self,
        idx: usize,
        rules: &Rules,
        l: &mut Ledger,
        owner: u32,
        units: u128,
        ts: u64,
        block: u64,
    ) -> Result<u128, String> {
        let e = self.pools[idx].key.expiry;
        let shared = self.window_ends.get(&e).copied();
        self.pools[idx].repay_at(rules, l, owner, units, ts, block, shared)
    }

    /// `closeWindow`; unlocks R behind rollovers that never filled.
    pub fn close(
        &mut self,
        idx: usize,
        rules: &Rules,
        l: &mut Ledger,
        block: u64,
    ) -> Result<(), String> {
        let unlock = self.pools[idx].close(rules, l, block)?;
        for (old, units) in unlock {
            self.unlock_r(old, units);
        }
        Ok(())
    }

    /// Mature + close every pool of `expiry` whose window has ended (what the keeper does).
    pub fn advance_expiry(
        &mut self,
        expiry: u64,
        rules: &Rules,
        l: &mut Ledger,
        ts: u64,
        block: u64,
    ) {
        for i in 0..self.pools.len() {
            if self.pools[i].key.expiry == expiry
                && self.pools[i].status == Status::Open
                && ts >= expiry
            {
                let _ = self.mature(i, ts, block);
            }
        }
        for i in 0..self.pools.len() {
            if self.pools[i].key.expiry == expiry && self.pools[i].status == Status::Window {
                let _ = self.close(i, rules, l, block);
            }
        }
    }

    // ------------------------------------------------------------------ statistics

    /// Statistics as `marketStats(market, expiry)` would report them (recomputed from pool traces).
    pub fn stats(&self, expiry: u64) -> ExpiryStats {
        let mut st = ExpiryStats::default();
        let mut any = false;
        let mut all_closed = true;
        for p in self.pools.iter().filter(|p| p.key.expiry == expiry) {
            any = true;
            let scale = p.scale;
            let vol: u128 = p
                .fills
                .iter()
                .filter(|f| matches!(f.side, Side::Sell | Side::NcSell))
                .map(|f| quote_down(f.units, f.price, scale))
                .sum();
            st.volume += vol;
            if vol != 0 {
                *st.volume_by_strike.entry(p.key.strike).or_default() += vol;
                st.last_price_by_strike
                    .insert(p.key.strike, p.last_clearing_price);
            }
            st.fees_paid += p.fees_to_treasury;
            st.bad |= p.bad;
            all_closed &= p.status == Status::Closed;
        }
        st.closed = any && all_closed;
        st
    }

    /// Graduation: `cycles` consecutive closed expiries that each meet the rule's metric with no pause / breaker.
    pub fn check_graduation(&mut self, rules: &Rules, cycles: usize) -> bool {
        if self.graduated {
            return true;
        }
        let exps: Vec<u64> = self
            .expiries()
            .into_iter()
            .filter(|&e| self.stats(e).closed)
            .collect();
        if exps.len() < cycles {
            return false;
        }
        let tail = &exps[exps.len() - cycles..];
        let ok = tail.iter().all(|&e| {
            let st = self.stats(e);
            !st.bad
                && match rules.graduation {
                    GradRule::Volume(t) => st.volume >= t,
                    GradRule::Fees(t) => st.fees_paid >= t,
                }
        });
        if ok {
            self.graduated = true;
            self.graduated_at = Some(*tail.last().unwrap());
        }
        ok
    }

    /// Vault tier selection for the expiry after `last_expiry`: (Low/Main strike, High strike).
    /// `guard` (develop's 2026-10-24 addition): only strikes whose last clearing price lies within
    /// `band_bps` of the previous expiry's market-wide VWAP are candidates; no VWAP → no investment.
    pub fn select_tiers(&self, rules: &Rules, last_expiry: u64) -> (Option<u128>, Option<u128>) {
        self.select_tiers_guarded(rules, last_expiry, None)
    }

    pub fn select_tiers_guarded(
        &self,
        rules: &Rules,
        last_expiry: u64,
        guard_band_bps: Option<u128>,
    ) -> (Option<u128>, Option<u128>) {
        let st = self.stats(last_expiry);
        if st.volume_by_strike.is_empty() {
            return (None, None);
        }
        let mut candidates: BTreeMap<u128, u128> = st.volume_by_strike.clone();
        if let Some(band) = guard_band_bps {
            let vwap = st.vwap(self.scale());
            if vwap == 0 {
                return (None, None);
            }
            candidates.retain(|k, _| within_band(st.last_price_by_strike[k], vwap, band));
            if candidates.is_empty() {
                return (None, None);
            }
        }
        match rules.tier {
            TierRule::LowestHighestTraded => (
                candidates.keys().next().copied(),
                candidates.keys().next_back().copied(),
            ),
            TierRule::MainHighTier => {
                let (main_k, main_v) = candidates
                    .iter()
                    .max_by_key(|(k, v)| (**v, std::cmp::Reverse(**k)))
                    .map(|(k, v)| (*k, *v))
                    .unwrap();
                let hi = candidates
                    .iter()
                    .filter(|(_, v)| **v * 5 >= main_v)
                    .map(|(k, _)| *k)
                    .max();
                let traded_expiries = |k: u128| {
                    self.expiries()
                        .iter()
                        .filter(|&&e| self.stats(e).volume_by_strike.contains_key(&k))
                        .count()
                };
                let main = if traded_expiries(main_k) >= 2 {
                    Some(main_k)
                } else {
                    None
                };
                let hi = hi.filter(|&k| traded_expiries(k) >= 2);
                (main, hi)
            }
        }
    }

    /// Vault protective limit under the guard: min(K − 1, prev VWAP × (1 + band)).
    pub fn guarded_limit(&self, last_expiry: u64, k: u128, band_bps: u128) -> u128 {
        let vwap = self.stats(last_expiry).vwap(self.scale());
        let cap = vwap * (BPS + band_bps) / BPS;
        cap.min(k - 1)
    }

    /// Shared window end for an expiry (first `mature` of that expiry sets it).
    pub fn window_end(&self, expiry: u64) -> Option<u64> {
        self.window_ends.get(&expiry).copied()
    }

    pub fn total_escrowed_quote(&self) -> u128 {
        self.pools
            .iter()
            .map(|p| p.escrowed_quote() + p.quote_bal + p.fee_escrow + p.surplus_bal)
            .sum()
    }
    pub fn total_escrowed_asset(&self) -> u128 {
        self.pools
            .iter()
            .map(|p| p.escrowed_asset() + p.asset_bal)
            .sum()
    }

    /// ARCHITECTURE §2.11 #1, #2 and 3c across all pools. Returns the first violation.
    pub fn check_invariants(&self, l: &Ledger) -> Result<(), String> {
        let need_q = self.total_escrowed_quote() + l.total_pending_quote();
        if l.core_quote < need_q {
            return Err(format!(
                "inv1 quote: core holds {} < {}",
                l.core_quote, need_q
            ));
        }
        let need_a = self.total_escrowed_asset() + l.total_pending_asset();
        if l.core_asset < need_a {
            return Err(format!(
                "inv1 asset: core holds {} < {}",
                l.core_asset, need_a
            ));
        }
        for (i, p) in self.pools.iter().enumerate() {
            let r_sum: u128 = p.r_bal.values().sum();
            if r_sum != p.r_supply {
                return Err(format!("inv2 R supply pool {i}"));
            }
            let c_sum: u128 = p.c_bal.values().sum();
            if c_sum != p.c_supply {
                return Err(format!("inv2 C supply pool {i}"));
            }
            if p.status != Status::Closed && p.r_supply + p.repaid_units != p.total_units {
                return Err(format!(
                    "inv2 pool {i}: R + repaid != total ({} + {} != {})",
                    p.r_supply, p.repaid_units, p.total_units
                ));
            }
            if p.status != Status::Closed && p.asset_bal != p.r_supply {
                return Err(format!(
                    "pool {i}: asset {} != unrepaid R {}",
                    p.asset_bal, p.r_supply
                ));
            }
            for (a, locked) in &p.locked_r {
                if *locked > p.r_of(*a) {
                    return Err(format!("pool {i}: locked R > R for {a}"));
                }
            }
            if p.paused_total > p.grid.max_pause_blocks * 1000 {
                return Err("absurd pause".into());
            }
        }
        Ok(())
    }
}
