//! Mechanism switches. `Rules::v07()` is what the deployed contracts do today; `Rules::v08()` is the
//! 2026-10-23 decision set (BLUEPRINT v0.8, IMPLEMENTATION_NOTES §8), not yet implemented in Solidity.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeeRule {
    /// Pool-level VWAP; `feeBps` of `(K − vwap)` charged on `repay`, nothing on default.
    VwapOnRepay { fee_bps: u128 },
    /// Per fill: `spread_bps` of `(K − P*)` into `feeEscrow` (split at close by repaid ratio) plus
    /// `trade_ppm` (parts per million) of the traded quote from each side straight to the treasury.
    PerFillEscrow {
        spread_bps: u128,
        trade_ppm_each_side: u128,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PricingRule {
    /// Competitive orders set P*; non-competitive orders only take the leftovers at P*.
    CompetitiveOnly,
    /// Non-competitive buy budgets enter the demand curve as "any price" demand (capped at 50% of the
    /// competitive volume); non-competitive sells still only take leftovers.
    NcBuyInDemand,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GradRule {
    /// Quote volume traded at the expiry ≥ threshold.
    Volume(u128),
    /// Fees actually paid to the treasury at the expiry ≥ threshold.
    Fees(u128),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TierRule {
    /// Low vault: lowest strike with any fill last expiry; High vault: highest strike with any fill.
    LowestHighestTraded,
    /// Low vault: strike with the largest volume last expiry; High vault: highest strike with volume ≥ 20% of it.
    /// Target pool must have traded in ≥ 2 expiries and have `auto_sell` on.
    MainHighTier,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseRule {
    /// Each pause ≤ MAX blocks, renewable without limit.
    PerPause,
    /// Cumulative paused blocks per pool ≤ MAX; cannot pause while a pause is running.
    Cumulative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub fee: FeeRule,
    pub pricing: PricingRule,
    pub graduation: GradRule,
    pub tier: TierRule,
    pub pause: PauseRule,
    /// Non-competitive fills ≤ competitive fills × this (bps). Both versions: 5000.
    pub nc_share_bps: u128,
    pub breaker_failures: u32,
    /// v0.8 (BLUEPRINT §3.7.5): a rollover may fill in the last new-pool batch before the old expiry.
    pub rollover_last_batch: bool,
    /// Dilution-fix variant B (not decided): competitive clearing must stay inside the widened band.
    pub competitive_band: bool,
    /// Dilution-fix variant A (not decided): C and R are tranched per settlement batch, so a batch's
    /// defaults fall only on the C bought in that batch.
    pub tranche_c: bool,
}

impl Rules {
    /// Current contracts (Monad / HyperEVM testnet deployments of 2026-10-13).
    pub fn v07() -> Self {
        Rules {
            fee: FeeRule::VwapOnRepay { fee_bps: 1000 },
            pricing: PricingRule::CompetitiveOnly,
            graduation: GradRule::Volume(500_000_000_000), // 500k USDC (6 dp)
            tier: TierRule::LowestHighestTraded,
            pause: PauseRule::PerPause,
            nc_share_bps: 5000,
            breaker_failures: 3,
            rollover_last_batch: false,
            competitive_band: false,
            tranche_c: false,
        }
    }

    /// 2026-10-23 decisions.
    pub fn v08() -> Self {
        Rules {
            fee: FeeRule::PerFillEscrow {
                spread_bps: 500,
                trade_ppm_each_side: 150,
            }, // 5% and 0.015%
            pricing: PricingRule::NcBuyInDemand,
            graduation: GradRule::Fees(150_000_000), // 150 USDC per expiry
            tier: TierRule::MainHighTier,
            pause: PauseRule::Cumulative,
            nc_share_bps: 5000,
            breaker_failures: 3,
            rollover_last_batch: true,
            competitive_band: false,
            tranche_c: false,
        }
    }

    pub fn name(&self) -> &'static str {
        match (self.fee, self.tranche_c) {
            (FeeRule::VwapOnRepay { .. }, _) => "v07",
            (FeeRule::PerFillEscrow { .. }, false) => "v08",
            (FeeRule::PerFillEscrow { .. }, true) => "v08_tranche",
        }
    }

    /// The rule set this repository recommends for the next contract version: v0.8 plus dilution-fix
    /// variant A. Adopted as the simulation default on 2026-10-24 after `dilution_variants` /
    /// `fee_wash` / `chaos` showed it removes the wash-and-default profit with honest flows unchanged.
    /// The founder can revert to the shared pot by setting `tranche_c = false`.
    pub fn recommended() -> Self {
        Self::v08_tranche()
    }

    /// v0.8 plus dilution-fix variant A (per-batch C/R tranches).
    pub fn v08_tranche() -> Self {
        let mut r = Self::v08();
        r.tranche_c = true;
        r
    }
}
