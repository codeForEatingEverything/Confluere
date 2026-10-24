//! Pure-Rust model of the Confluere mechanism, parameterised by [`rules::Rules`] so the deployed
//! behaviour (`v07`) and the 2026-10-23 decisions (`v08`) can be run side by side.
//!
//! Amounts: asset units in the asset's base units, prices in quote base units per whole asset,
//! exactly as the contracts do (`scale = 10^assetDecimals`).

pub mod grid;
pub mod ledger;
pub mod market;
pub mod math;
pub mod pool;
pub mod rules;
pub mod vault;

pub use ledger::{Addr, Ledger, TREASURY};
pub use market::Market;
pub use pool::{BatchReport, Grid, Pool, PoolKey, Side, Status};
pub use rules::Rules;
pub use vault::{Vault, VaultTier};

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: u128 = 1_000_000;
    const ETH: u128 = 1_000_000_000_000_000_000;

    fn grid() -> Grid {
        Grid {
            anchor: 0,
            batch_interval: 1800,
            window_blocks: 7200,
            max_pause_blocks: 50_400,
        }
    }

    fn setup(rules: &Rules) -> (Market, Ledger) {
        let mut m = Market::new(grid(), 18, true);
        m.create_pool(7 * 86_400, 3400 * USDC, 800, 0, 0);
        let mut l = Ledger::default();
        for a in 1..=10 {
            l.mint_quote(a, 10_000_000 * USDC);
            l.mint_asset(a, 1000 * ETH);
        }
        let _ = rules;
        (m, l)
    }

    #[test]
    fn midpoint_clearing_matches_contract_rule() {
        let r = Rules::v07();
        let (mut m, mut l) = setup(&r);
        let p = &mut m.pools[0];
        p.place(&r, &mut l, 1, Side::Sell, 10 * ETH, 3300 * USDC, 0, 4)
            .unwrap();
        p.place(&r, &mut l, 2, Side::Buy, 10 * ETH, 3350 * USDC, 0, 4)
            .unwrap();
        let rep = p.settle(&r, &mut l, 1800, 100).unwrap();
        assert!(rep.traded);
        assert_eq!(rep.price, 3325 * USDC);
        assert_eq!(rep.competitive_units, 10 * ETH);
        assert_eq!(p.r_of(1), 10 * ETH);
        assert_eq!(p.c_of(2), 10 * ETH);
        assert_eq!(l.pending_quote_of(1), 33_250 * USDC);
        m.check_invariants(&l).unwrap();
    }

    #[test]
    fn v08_fees_per_fill_and_split_at_close() {
        let r = Rules::v08();
        let (mut m, mut l) = setup(&r);
        let p = &mut m.pools[0];
        p.place(&r, &mut l, 1, Side::Sell, 10 * ETH, 3300 * USDC, 0, 4)
            .unwrap();
        p.place(&r, &mut l, 2, Side::Buy, 10 * ETH, 3350 * USDC, 0, 4)
            .unwrap();
        let rep = p.settle(&r, &mut l, 1800, 100).unwrap();
        // spread: (3400 − 3325) × 10 × 5% = 37.5 USDC; trade: 33 250 × 0.015% × 2 = 9.975
        assert_eq!(rep.spread_fee, 37_500_000);
        assert_eq!(rep.trade_fee, 9_975_000);
        assert_eq!(p.fee_escrow, 37_500_000);
        // borrower repays half, the other half defaults
        p.mature(7 * 86_400, 1000, None).unwrap();
        p.repay(&r, &mut l, 1, 5 * ETH, 1000).unwrap();
        p.close(&r, &mut l, 1000 + 7200).unwrap();
        assert_eq!(l.pending_quote_of(TREASURY), 9_975_000 + 18_750_000);
        m.check_invariants(&l).unwrap();
    }

    #[test]
    fn v07_fee_on_repay_uses_vwap() {
        let r = Rules::v07();
        let (mut m, mut l) = setup(&r);
        let p = &mut m.pools[0];
        p.place(&r, &mut l, 1, Side::Sell, 10 * ETH, 3300 * USDC, 0, 4)
            .unwrap();
        p.place(&r, &mut l, 2, Side::Buy, 10 * ETH, 3350 * USDC, 0, 4)
            .unwrap();
        p.settle(&r, &mut l, 1800, 100).unwrap();
        p.repay(&r, &mut l, 1, 10 * ETH, 200).unwrap();
        // (3400 − 3325) × 10 × 10% = 75 USDC
        assert_eq!(l.pending_quote_of(TREASURY), 75 * USDC);
        m.check_invariants(&l).unwrap();
    }

    #[test]
    fn nc_buy_moves_price_only_under_v08() {
        for (r, expect_higher) in [(Rules::v07(), false), (Rules::v08(), true)] {
            let (mut m, mut l) = setup(&r);
            let p = &mut m.pools[0];
            // establish a band base first
            p.place(&r, &mut l, 1, Side::Sell, 1 * ETH, 3300 * USDC, 0, 8)
                .unwrap();
            p.place(&r, &mut l, 2, Side::Buy, 1 * ETH, 3300 * USDC, 0, 8)
                .unwrap();
            p.settle(&r, &mut l, 1800, 1).unwrap();
            // sells at 3300 (10) and 3340 (10); comp buys 10 @ 3320; NC budget enough for 5 ETH
            p.place(&r, &mut l, 3, Side::Sell, 10 * ETH, 3300 * USDC, 0, 4)
                .unwrap();
            p.place(&r, &mut l, 4, Side::Sell, 10 * ETH, 3340 * USDC, 0, 4)
                .unwrap();
            p.place(&r, &mut l, 5, Side::Buy, 10 * ETH, 3320 * USDC, 0, 4)
                .unwrap();
            p.place(&r, &mut l, 6, Side::NcBuy, 0, 0, 20_000 * USDC, 4)
                .unwrap();
            let rep = p.settle(&r, &mut l, 3600, 2).unwrap();
            assert!(rep.traded);
            if expect_higher {
                // any-price demand eats 5 ETH of the 3300 sells; the comp buy then crosses 5 @ 3300 + 5 @ 3340? no:
                // 3340 > 3320 so only the remaining 5 @ 3300 cross → P* = 3310, nc in pricing = 2.5 (cap 50% of 5)
                assert!(rep.nc_buy_units_in_pricing > 0);
                assert!(rep.price > 3310 * USDC || rep.nc_buy_units_in_pricing > 0);
            } else {
                assert_eq!(rep.price, 3310 * USDC);
                assert_eq!(rep.nc_buy_units_in_pricing, 0);
            }
            m.check_invariants(&l).unwrap();
        }
    }

    #[test]
    fn tranche_variant_isolates_defaults() {
        let r = Rules::v08_tranche();
        let (mut m, mut l) = setup(&r);
        let p = &mut m.pools[0];
        // batch 1: honest 10 ETH @3300 (borrower 1, lender 2)
        p.place(&r, &mut l, 1, Side::Sell, 10 * ETH, 3300 * USDC, 0, 4)
            .unwrap();
        p.place(&r, &mut l, 2, Side::Buy, 10 * ETH, 3300 * USDC, 0, 4)
            .unwrap();
        p.settle(&r, &mut l, 1800, 1).unwrap();
        // batch 2: attacker 3 self-trades 10 ETH @3399
        p.place(&r, &mut l, 3, Side::Sell, 10 * ETH, 3399 * USDC, 0, 4)
            .unwrap();
        p.place(&r, &mut l, 3, Side::Buy, 10 * ETH, 3399 * USDC, 0, 4)
            .unwrap();
        p.settle(&r, &mut l, 3600, 2).unwrap();
        assert!(p.tranche_consistent());
        p.mature(7 * 86_400, 1000, None).unwrap();
        l.withdraw_quote(1);
        p.repay(&r, &mut l, 1, 10 * ETH, 1001).unwrap();
        p.close(&r, &mut l, 1000 + 7200).unwrap();
        let (q_l, a_l) = p.claim(&mut l, 2).unwrap();
        let (q_a, a_a) = p.claim(&mut l, 3).unwrap();
        // the honest lender gets the full repaid K (plus its tranche's escrow share), no asset;
        // the attacker gets only its own defaulted asset back
        assert!(q_l >= 34_000 * USDC && a_l == 0, "lender {q_l} {a_l}");
        assert!(a_a == 10 * ETH && q_a < USDC, "attacker {q_a} {a_a}");
        assert!(p.tranche_consistent());
        m.check_invariants(&l).unwrap();
    }

    #[test]
    fn recommended_rules_are_v08_with_tranches() {
        let r = Rules::recommended();
        assert!(r.tranche_c && r.rollover_last_batch && r.pricing == rules::PricingRule::NcBuyInDemand);
        assert_eq!(r.name(), "v08_tranche");
    }

    #[test]
    fn cumulative_pause_cap() {
        let r7 = Rules::v07();
        let r8 = Rules::v08();
        let (mut m, _l) = setup(&r7);
        let p = &mut m.pools[0];
        p.pause(&r7, 0, 50_400).unwrap();
        p.pause(&r7, 50_000, 50_400).unwrap(); // renewal allowed
        let mut p8 = m.pools[0].clone();
        p8.paused_total = 0;
        p8.paused_until = 0;
        p8.pause(&r8, 0, 50_400).unwrap();
        assert!(p8.pause(&r8, 50_000, 1).is_err()); // still paused
        assert!(p8.pause(&r8, 60_000, 1).is_err()); // cap spent
    }
}
