//! Section 1 "average borrow and redeem": one pool, random borrowers and lenders every batch until expiry,
//! rational repay/default at expiry. Same seed under v0.7 and v0.8 rules.

use crate::common::*;
use confluere_model::{Rules, Side, TREASURY};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;

#[derive(Serialize)]
struct BatchRow {
    rules: &'static str,
    seed: u64,
    batch: u32,
    ref_price: f64,
    traded: bool,
    price: f64,
    implied_apr: f64,
    competitive_units: f64,
    nc_units: f64,
    nc_in_pricing_units: f64,
    spread_fee: f64,
    trade_fee: f64,
    band_failures: u32,
}

#[derive(Serialize)]
struct Summary {
    rules: &'static str,
    seed: u64,
    final_ref_price: f64,
    total_units: f64,
    repaid_units: f64,
    default_ratio: f64,
    treasury_fees: f64,
    c_holder_quote: f64,
    c_holder_asset: f64,
    lender_return_on_quote_paid: f64,
    borrower_fee_paid: f64,
}

pub fn run(seeds: u64) {
    let k = 3400 * USDC;
    let expiry = 7 * DAY;
    let mut batches = Vec::new();
    let mut summaries = Vec::new();
    for seed in 0..seeds {
        for rules in [Rules::v07(), Rules::v08(), Rules::v08_tranche()] {
            let mut rng = ChaCha8Rng::seed_from_u64(seed);
            let (mut m, mut l) = fresh(&rules, k, expiry, 800, 40);
            let mut ref_price = 3350.0f64;
            let n_batches = (expiry / BATCH) as u32;
            let mut quote_paid_by_lenders = 0u128;
            for b in 0..n_batches {
                ref_price *= 1.0 + rng.random_range(-0.01..0.01);
                let rp = (ref_price * USDC as f64) as u128;
                let p = &mut m.pools[0];
                // borrowers: sell 1–10 ETH, willing to take a 0.3%–2% discount below reference
                for _ in 0..rng.random_range(1..=4) {
                    let who = rng.random_range(1..=20);
                    let units = rand_range(&mut rng, 1, 10) * ETH;
                    let disc = rng.random_range(0.003..0.02);
                    let lim = (rp as f64 * (1.0 - disc)) as u128;
                    let _ = p.place(&rules, &mut l, who, Side::Sell, units, lim, 0, 2);
                }
                // lenders: buy 1–10 ETH, bid 0%–1.5% below reference, never above K
                for _ in 0..rng.random_range(1..=4) {
                    let who = rng.random_range(21..=35);
                    let units = rand_range(&mut rng, 1, 10) * ETH;
                    let disc = rng.random_range(0.0..0.015);
                    let lim = ((rp as f64 * (1.0 - disc)) as u128).min(k - USDC);
                    let _ = p.place(&rules, &mut l, who, Side::Buy, units, lim, 0, 2);
                }
                // retail / vault non-competitive budget
                if rng.random_range(0..3) == 0 {
                    let who = rng.random_range(36..=40);
                    let budget = rand_range(&mut rng, 5_000, 40_000) * USDC;
                    let _ = p.place(&rules, &mut l, who, Side::NcBuy, 0, 0, budget, 1);
                }
                let ts = (b as u64 + 1) * BATCH;
                let before: u128 = (21..=40).map(|a| l.quote_of(a)).sum();
                let rep = p.settle(&rules, &mut l, ts, b as u64 * 10).unwrap();
                let after: u128 = (21..=40).map(|a| l.quote_of(a)).sum();
                // lenders' wallets shrink by escrow at placement, refunds come back via pending; track paid later
                let _ = (before, after);
                batches.push(BatchRow {
                    rules: rules.name(),
                    seed,
                    batch: b,
                    ref_price,
                    traded: rep.traded,
                    price: usdc(rep.price),
                    implied_apr: if rep.traded {
                        apr(rep.price, k, 7.0)
                    } else {
                        f64::NAN
                    },
                    competitive_units: eth(rep.competitive_units),
                    nc_units: eth(rep.nc_units),
                    nc_in_pricing_units: eth(rep.nc_buy_units_in_pricing),
                    spread_fee: usdc(rep.spread_fee),
                    trade_fee: usdc(rep.trade_fee),
                    band_failures: rep.band_failures,
                });
                m.check_invariants(&l).unwrap();
            }
            // expiry: rational borrowers repay only if the asset is worth more than K
            let block = 100_000;
            m.pools[0].mature(expiry, block, None).unwrap();
            let final_ref = ref_price;
            let repay_all = final_ref * USDC as f64 > k as f64;
            for a in 1..=20u32 {
                let r = m.pools[0].r_of(a);
                if r != 0 && repay_all {
                    // forgetful 5%
                    if rng.random_range(0..20) != 0 {
                        m.pools[0].repay(&rules, &mut l, a, r, block + 10).unwrap();
                    }
                }
            }
            m.pools[0]
                .close(&rules, &mut l, block + WINDOW_BLOCKS)
                .unwrap();
            m.check_invariants(&l).unwrap();
            let p = &m.pools[0];
            // what lenders actually paid: Σ fills on the buy side
            for f in &p.fills {
                if matches!(f.side, Side::Buy | Side::NcBuy) {
                    quote_paid_by_lenders +=
                        confluere_model::math::quote_up(f.units, f.price, p.scale);
                }
            }
            let borrower_fee: u128 = p.fees_to_treasury;
            let s = Summary {
                rules: rules.name(),
                seed,
                final_ref_price: final_ref,
                total_units: eth(p.total_units),
                repaid_units: eth(p.repaid_units),
                default_ratio: if p.total_units == 0 {
                    0.0
                } else {
                    1.0 - p.repaid_units as f64 / p.total_units as f64
                },
                treasury_fees: usdc(l.pending_quote_of(TREASURY)),
                c_holder_quote: usdc(p.quote_bal),
                c_holder_asset: eth(p.asset_bal),
                lender_return_on_quote_paid: if quote_paid_by_lenders == 0 {
                    0.0
                } else {
                    (p.quote_bal as f64 + p.asset_bal as f64 * final_ref * USDC as f64 / ETH as f64)
                        / quote_paid_by_lenders as f64
                        - 1.0
                },
                borrower_fee_paid: usdc(borrower_fee),
            };
            summaries.push(s);
        }
    }
    write_csv("baseline_batches.csv", &batches);
    write_csv("baseline_summary.csv", &summaries);
}
