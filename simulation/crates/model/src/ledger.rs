//! External balances and the core's pull-refund ledger. One quote token and one asset token per market.

use std::collections::BTreeMap;

pub type Addr = u32;
pub const TREASURY: Addr = 0;

#[derive(Default, Debug, Clone)]
pub struct Ledger {
    /// Wallet balances outside the core.
    pub quote: BTreeMap<Addr, u128>,
    pub asset: BTreeMap<Addr, u128>,
    /// `pending[token][account]` inside the core (claimable with `withdraw`).
    pub pending_quote: BTreeMap<Addr, u128>,
    pub pending_asset: BTreeMap<Addr, u128>,
    /// Token balances the core contract holds.
    pub core_quote: u128,
    pub core_asset: u128,
}

impl Ledger {
    pub fn mint_quote(&mut self, a: Addr, amt: u128) {
        *self.quote.entry(a).or_default() += amt;
    }
    pub fn mint_asset(&mut self, a: Addr, amt: u128) {
        *self.asset.entry(a).or_default() += amt;
    }
    pub fn quote_of(&self, a: Addr) -> u128 {
        *self.quote.get(&a).unwrap_or(&0)
    }
    pub fn asset_of(&self, a: Addr) -> u128 {
        *self.asset.get(&a).unwrap_or(&0)
    }
    pub fn pending_quote_of(&self, a: Addr) -> u128 {
        *self.pending_quote.get(&a).unwrap_or(&0)
    }
    pub fn pending_asset_of(&self, a: Addr) -> u128 {
        *self.pending_asset.get(&a).unwrap_or(&0)
    }

    /// Wallet → core (escrow, repayment, bid).
    pub fn pull_quote(&mut self, a: Addr, amt: u128) -> Result<(), String> {
        let b = self.quote.entry(a).or_default();
        if *b < amt {
            return Err(format!("insufficient quote: {a} has {b}, needs {amt}"));
        }
        *b -= amt;
        self.core_quote += amt;
        Ok(())
    }
    pub fn pull_asset(&mut self, a: Addr, amt: u128) -> Result<(), String> {
        let b = self.asset.entry(a).or_default();
        if *b < amt {
            return Err(format!("insufficient asset: {a} has {b}, needs {amt}"));
        }
        *b -= amt;
        self.core_asset += amt;
        Ok(())
    }
    /// Core → pending (never pushed).
    pub fn credit_quote(&mut self, a: Addr, amt: u128) {
        *self.pending_quote.entry(a).or_default() += amt;
    }
    pub fn credit_asset(&mut self, a: Addr, amt: u128) {
        *self.pending_asset.entry(a).or_default() += amt;
    }
    /// `withdraw`: pending → wallet.
    pub fn withdraw_quote(&mut self, a: Addr) -> u128 {
        let amt = self.pending_quote.remove(&a).unwrap_or(0);
        self.core_quote -= amt;
        *self.quote.entry(a).or_default() += amt;
        amt
    }
    pub fn withdraw_asset(&mut self, a: Addr) -> u128 {
        let amt = self.pending_asset.remove(&a).unwrap_or(0);
        self.core_asset -= amt;
        *self.asset.entry(a).or_default() += amt;
        amt
    }
    /// `repay` returns asset directly (the one push the design allows), `claim` likewise.
    pub fn push_asset(&mut self, a: Addr, amt: u128) {
        self.core_asset -= amt;
        *self.asset.entry(a).or_default() += amt;
    }
    pub fn push_quote(&mut self, a: Addr, amt: u128) {
        self.core_quote -= amt;
        *self.quote.entry(a).or_default() += amt;
    }
    pub fn total_pending_quote(&self) -> u128 {
        self.pending_quote.values().sum()
    }
    pub fn total_pending_asset(&self) -> u128 {
        self.pending_asset.values().sum()
    }
}
