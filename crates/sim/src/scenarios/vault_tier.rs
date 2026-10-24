//! BLUEPRINT §5 (2026-10-23): vault strike selection by volume instead of "lowest / highest traded".
//! An honest market trades across five strikes for three expiries; an attacker then opens an absurd strike
//! and wash-trades the minimum. Which strike does each vault pick, and what does flipping v0.8's choice cost?

use crate::common::*;
use confluere_model::{Ledger, Market, Rules, Side};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    attack: &'static str,
    attacker_wash_usdc: f64,
    attacker_fee_cost_usdc: f64,
    low_vault_strike: Option<f64>,
    high_vault_strike: Option<f64>,
    honest_main_strike: f64,
    low_vault_hijacked: bool,
    high_vault_hijacked: bool,
}

const STRIKES: [u128; 5] = [3200, 3300, 3400, 3500, 3600];
/// Honest quote volume per expiry per strike (USDC): 3400 is the main tier.
const VOLUMES: [u128; 5] = [40_000, 150_000, 400_000, 120_000, 30_000];

fn honest_market(rules: &Rules, expiries: &[u64]) -> (Market, Ledger) {
    let mut m = Market::new(grid(), 18, true);
    let mut l = Ledger::default();
    for a in 1..=4 {
        l.mint_quote(a, 1_000_000_000 * USDC);
        l.mint_asset(a, 1_000_000 * ETH);
    }
    for (ei, &e) in expiries.iter().enumerate() {
        for (i, k) in STRIKES.iter().enumerate() {
            let idx = m.create_pool(e, k * USDC, 800, 0, 0);
            let price = (k - 50) * USDC;
            let units = VOLUMES[i] * USDC * ETH / price;
            let p = &mut m.pools[idx];
            p.place(rules, &mut l, 1, Side::Sell, units, price, 0, 2)
                .unwrap();
            p.place(rules, &mut l, 2, Side::Buy, units, price, 0, 2)
                .unwrap();
            let ts = e - 6 * DAY + (ei as u64) * BATCH + BATCH;
            p.settle(rules, &mut l, ts, 1).unwrap();
        }
    }
    (m, l)
}

fn finish_expiry(rules: &Rules, m: &mut Market, l: &mut Ledger, e: u64, block: u64) {
    for p in m.pools.iter_mut().filter(|p| p.key.expiry == e) {
        p.mature(e, block, None).unwrap();
        for a in 1..=4 {
            let r = p.r_of(a);
            if r != 0 {
                l.withdraw_quote(a);
                p.repay(rules, l, a, r, block + 1).unwrap();
            }
        }
        p.close(rules, l, block + WINDOW_BLOCKS).unwrap();
    }
}

pub fn run() {
    let expiries = [7 * DAY, 14 * DAY, 21 * DAY];
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        // attacks: none / tiny wash at 2× price / tiny wash at a very low strike / big wash at 2× (v0.8 flip)
        for attack in [
            "none",
            "tiny_high_strike",
            "tiny_low_strike",
            "outvolume_high_strike",
        ] {
            let (mut m, mut l) = honest_market(&rules, &expiries);
            let attacker = 4;
            let start = l.quote_of(attacker);
            let mut wash = 0u128;
            match attack {
                "none" => {}
                "tiny_high_strike" | "outvolume_high_strike" => {
                    let k = 6800 * USDC;
                    // the attacker needs ≥ 2 expiries of fills under v0.8, so trade at expiries 2 and 3
                    for &e in &expiries[1..] {
                        let idx = m.create_pool(e, k, 800, 0, 0);
                        let price = k - USDC;
                        let notional = if attack == "tiny_high_strike" {
                            10 * USDC
                        } else {
                            400_001 * USDC
                        };
                        let units = notional * ETH / price;
                        let p = &mut m.pools[idx];
                        p.place(&rules, &mut l, attacker, Side::Sell, units, price, 0, 2)
                            .unwrap();
                        p.place(&rules, &mut l, attacker, Side::Buy, units, price, 0, 2)
                            .unwrap();
                        p.settle(&rules, &mut l, e - DAY, 1).unwrap();
                        wash += notional;
                    }
                }
                "tiny_low_strike" => {
                    let k = 1000 * USDC;
                    for &e in &expiries[1..] {
                        let idx = m.create_pool(e, k, 800, 0, 0);
                        let price = k - USDC;
                        let units = 10 * USDC * ETH / price;
                        let p = &mut m.pools[idx];
                        p.place(&rules, &mut l, attacker, Side::Sell, units, price, 0, 2)
                            .unwrap();
                        p.place(&rules, &mut l, attacker, Side::Buy, units, price, 0, 2)
                            .unwrap();
                        p.settle(&rules, &mut l, e - DAY, 1).unwrap();
                        wash += 10 * USDC;
                    }
                }
                _ => unreachable!(),
            }
            for (i, &e) in expiries.iter().enumerate() {
                finish_expiry(&rules, &mut m, &mut l, e, 100_000 * (i as u64 + 1));
            }
            for p in m.pools.iter_mut() {
                let _ = p.claim(&mut l, attacker);
            }
            l.withdraw_quote(attacker);
            l.withdraw_asset(attacker);
            m.check_invariants(&l).unwrap();
            let cost = start.saturating_sub(l.quote_of(attacker));
            let (lo, hi) = m.select_tiers(&rules, *expiries.last().unwrap());
            rows.push(Row {
                rules: rules.name(),
                attack,
                attacker_wash_usdc: usdc(wash),
                attacker_fee_cost_usdc: usdc(cost),
                low_vault_strike: lo.map(usdc),
                high_vault_strike: hi.map(usdc),
                honest_main_strike: 3400.0,
                low_vault_hijacked: lo
                    .map(|k| k == 1000 * USDC || k == 6800 * USDC)
                    .unwrap_or(false),
                high_vault_hijacked: hi.map(|k| k == 6800 * USDC).unwrap_or(false),
            });
        }
    }
    write_csv("vault_tier.csv", &rows);
}
