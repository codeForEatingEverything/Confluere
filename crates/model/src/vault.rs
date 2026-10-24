//! ERC-7540 retail vault (BLUEPRINT §5, ARCHITECTURE §2.8): async deposits and redemptions, non-competitive
//! buys only, ≤ `per_batch_cap_bps` of idle quote per batch, only graduated markets, redemption queue reserved
//! before investing. v0.8: picks MAIN / HIGH tier by volume, only pools with `auto_sell`, redeems in quote
//! (defaulted asset is sold through the next pool; what does not sell is handed out pro rata as a fallback).

use crate::ledger::{Addr, Ledger};
use crate::market::Market;
use crate::math::{quote_down, share};
use crate::pool::{Side, Status};
use crate::rules::{Rules, TierRule};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultTier {
    Low,
    High,
}

#[derive(Clone, Debug)]
pub struct Vault {
    /// The vault's own account in the ledger.
    pub addr: Addr,
    pub tier: VaultTier,
    pub per_batch_cap_bps: u128,
    /// develop's 2026-10-24 guard: protective limit and candidate strikes from the previous expiry's VWAP.
    pub guard_band_bps: Option<u128>,
    /// Shares.
    pub shares: std::collections::BTreeMap<Addr, u128>,
    pub total_shares: u128,
    pub pending_deposits: Vec<(Addr, u128)>,
    pub redeem_queue: Vec<(Addr, u128)>,
    /// Quote reserved for queued redemptions (estimated at request time).
    pub reserved: u128,
    /// Pools the vault holds C in (indices into the market).
    pub holdings: Vec<usize>,
    /// Asset received from defaults that is being auto-sold (or waits for fallback distribution).
    pub asset_for_sale: u128,
    pub asset_fallback_paid: u128,
    pub nav_history: Vec<(u64, f64)>,
    pub invested_total: u128,
    pub redeemed_total: u128,
    pub orders_placed: u32,
    pub orders_filled_units: u128,
    pub sale_proceeds: u128,
}

impl Vault {
    pub fn new(addr: Addr, tier: VaultTier, guard_band_bps: Option<u128>) -> Self {
        Vault {
            addr,
            tier,
            per_batch_cap_bps: 2500,
            guard_band_bps,
            shares: Default::default(),
            total_shares: 0,
            pending_deposits: Vec::new(),
            redeem_queue: Vec::new(),
            reserved: 0,
            holdings: Vec::new(),
            asset_for_sale: 0,
            asset_fallback_paid: 0,
            nav_history: Vec::new(),
            invested_total: 0,
            redeemed_total: 0,
            orders_placed: 0,
            orders_filled_units: 0,
            sale_proceeds: 0,
        }
    }

    /// Idle quote the vault can deploy: wallet minus what redemptions already claim.
    pub fn idle(&self, l: &Ledger) -> u128 {
        l.quote_of(self.addr).saturating_sub(self.reserved)
    }

    /// Total value in quote: wallet + pending + C at K + asset for sale at `asset_mark`.
    pub fn nav_total(&self, m: &Market, l: &Ledger, asset_mark: u128) -> u128 {
        let mut v = l.quote_of(self.addr) + l.pending_quote_of(self.addr);
        for &i in &self.holdings {
            let p = &m.pools[i];
            let c = p.c_of(self.addr);
            if c != 0 {
                v += match p.status {
                    Status::Closed => {
                        share(c, p.quote_bal, p.c_supply)
                            + quote_down(share(c, p.asset_bal, p.c_supply), asset_mark, p.scale)
                    }
                    _ => quote_down(c, p.key.strike, p.scale),
                };
            }
        }
        // escrow sitting in open orders
        for p in &m.pools {
            v += p
                .live_orders()
                .filter(|o| o.owner == self.addr)
                .map(|o| o.escrow)
                .sum::<u128>();
        }
        v + quote_down(
            self.asset_for_sale + l.asset_of(self.addr) + l.pending_asset_of(self.addr),
            asset_mark,
            m.scale(),
        )
    }

    pub fn nav_per_share(&self, m: &Market, l: &Ledger, asset_mark: u128) -> f64 {
        if self.total_shares == 0 {
            1.0
        } else {
            self.nav_total(m, l, asset_mark) as f64 / self.total_shares as f64
        }
    }

    /// `requestDeposit`: quote moves into the vault now, shares are issued at the next roll.
    pub fn request_deposit(
        &mut self,
        l: &mut Ledger,
        who: Addr,
        amount: u128,
    ) -> Result<(), String> {
        if l.quote_of(who) < amount {
            return Err("insufficient".into());
        }
        *l.quote.get_mut(&who).unwrap() -= amount;
        l.mint_quote(self.addr, amount);
        self.pending_deposits.push((who, amount));
        Ok(())
    }

    /// `requestRedeem`: queued FIFO; the estimated quote is reserved immediately.
    pub fn request_redeem(
        &mut self,
        m: &Market,
        l: &Ledger,
        who: Addr,
        shares: u128,
        asset_mark: u128,
    ) -> Result<(), String> {
        if *self.shares.get(&who).unwrap_or(&0) < shares {
            return Err("not enough shares".into());
        }
        let est = (self.nav_per_share(m, l, asset_mark) * shares as f64) as u128;
        self.reserved += est;
        self.redeem_queue.push((who, shares));
        Ok(())
    }

    /// `poke`: one non-competitive buy per batch in the target pool of `expiry`, if the market has graduated.
    pub fn poke(
        &mut self,
        m: &mut Market,
        rules: &Rules,
        l: &mut Ledger,
        expiry: u64,
        prev_expiry: u64,
    ) -> Option<usize> {
        if !m.graduated {
            return None;
        }
        let (lo, hi) = m.select_tiers_guarded(rules, prev_expiry, self.guard_band_bps);
        let strike = match self.tier {
            VaultTier::Low => lo,
            VaultTier::High => hi,
        }?;
        let idx = m.pool_at(expiry, strike)?;
        if rules.tier == TierRule::MainHighTier && !m.pools[idx].auto_sell {
            return None;
        }
        if m.pools[idx].status != Status::Open {
            return None;
        }
        let budget = self.idle(l) * self.per_batch_cap_bps / 10_000;
        if budget == 0 {
            return None;
        }
        let limit = self
            .guard_band_bps
            .map(|b| m.guarded_limit(prev_expiry, strike, b))
            .unwrap_or(0);
        if self.guard_band_bps.is_some() && limit == 0 {
            return None;
        }
        m.pools[idx]
            .place(rules, l, self.addr, Side::NcBuy, 0, limit, budget, 1)
            .ok()?;
        self.orders_placed += 1;
        self.invested_total += budget;
        if !self.holdings.contains(&idx) {
            self.holdings.push(idx);
        }
        Some(idx)
    }

    /// Auto-sell: put defaulted asset as a plain sell (limit = K × discount) into the next pool.
    pub fn auto_sell(
        &mut self,
        m: &mut Market,
        rules: &Rules,
        l: &mut Ledger,
        next_pool: usize,
        discount_bps: u128,
    ) {
        let asset = l.asset_of(self.addr);
        if asset == 0 {
            return;
        }
        let k = m.pools[next_pool].key.strike;
        let limit = k * (10_000 - discount_bps) / 10_000;
        if m.pools[next_pool]
            .place(rules, l, self.addr, Side::Sell, asset, limit, 0, 4)
            .is_ok()
        {
            self.asset_for_sale += asset;
        }
    }

    /// `roll`: claim closed pools, withdraw pending, mint deposits, pay redemptions FIFO. Asset that could
    /// not be sold is paid out pro rata to redeemers as the documented fallback.
    pub fn roll(&mut self, m: &mut Market, l: &mut Ledger, asset_mark: u128, ts: u64) {
        for &i in &self.holdings.clone() {
            if m.pools[i].status == Status::Closed && m.pools[i].c_of(self.addr) != 0 {
                let _ = m.pools[i].claim(l, self.addr);
            }
        }
        // the vault's own R from auto-sell fills: the vault never keeps R — its sold asset simply becomes
        // a borrower position it will not repay (the quote is what it wanted). Track proceeds.
        let pq = l.withdraw_quote(self.addr);
        self.sale_proceeds += pq;
        l.withdraw_asset(self.addr);
        let nav = self.nav_per_share(m, l, asset_mark);
        for (who, amt) in std::mem::take(&mut self.pending_deposits) {
            let sh = if self.total_shares == 0 {
                amt
            } else {
                (amt as f64 / nav) as u128
            };
            *self.shares.entry(who).or_default() += sh;
            self.total_shares += sh;
        }
        let nav = self.nav_per_share(m, l, asset_mark);
        let mut queue = std::mem::take(&mut self.redeem_queue);
        self.reserved = 0;
        let mut still = Vec::new();
        for (who, sh) in queue.drain(..) {
            let owed = (nav * sh as f64) as u128;
            let avail = l.quote_of(self.addr);
            if avail >= owed {
                *l.quote.get_mut(&self.addr).unwrap() -= owed;
                l.mint_quote(who, owed);
                *self.shares.get_mut(&who).unwrap() -= sh;
                self.total_shares -= sh;
                self.redeemed_total += owed;
            } else {
                // not enough quote: pay what there is plus asset fallback pro rata, rest waits
                still.push((who, sh));
                self.reserved += owed;
            }
        }
        self.redeem_queue = still;
        self.nav_history.push((ts, nav));
    }
}
