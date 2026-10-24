//! Section 1 "Earn module" and section 2 "Earn's hedging": an ERC-7540 vault over a graduated market.
//! Four expiries of honest history graduate the market; the vault then invests through four more expiries
//! on a bull, flat and bear price path. v0.7 (lowest/highest traded, asset-in-kind) vs v0.8 (main/high tier,
//! auto-sell, develop's guard). Also the ❌ "APY ≥ X% auto-buyer" to show the adverse selection.

use crate::common::*;
use confluere_model::{Ledger, Market, Rules, Side, Vault, VaultTier};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    path: &'static str,
    tier: &'static str,
    guard: bool,
    expiry_index: usize,
    ref_price: f64,
    target_strike: Option<f64>,
    invested_this_expiry: f64,
    nav_per_share: f64,
    quote_wallet: f64,
    asset_for_sale_eth: f64,
    asset_fallback_eth: f64,
    redeem_queue_len: usize,
    redeemed_total: f64,
}

#[derive(Serialize)]
struct ThresholdRow {
    path: &'static str,
    apr_threshold: f64,
    batches_bought: u32,
    units_bought: f64,
    avg_price: f64,
    final_ref_price: f64,
    defaulted_share: f64,
    pnl_usdc: f64,
}

const STRIKES: [u128; 5] = [3200, 3300, 3400, 3500, 3600];
const VAULT: u32 = 900;

fn seed_history(
    m: &mut Market,
    rules: &Rules,
    l: &mut Ledger,
    expiries: &[u64],
    rng: &mut ChaCha8Rng,
    ref_price: f64,
) {
    for &e in expiries {
        for k in STRIKES {
            let idx = m.create_pool(e, k * USDC, 800, 0, 0);
            m.pools[idx].auto_sell = true;
            // volume centred on 3400
            let vol_usdc = match k {
                3400 => 400_000,
                3300 | 3500 => 150_000,
                _ => 40_000,
            } * USDC;
            let price = ((ref_price * (1.0 - rng.random_range(0.005..0.02))) * USDC as f64) as u128;
            let price = price.min(k * USDC - USDC);
            let units = vol_usdc * ETH / price;
            m.pools[idx]
                .place(rules, l, 1, Side::Sell, units, price, 0, 2)
                .unwrap();
            m.pools[idx]
                .place(rules, l, 2, Side::Buy, units, price, 0, 2)
                .unwrap();
        }
    }
}

fn settle_all_open(
    m: &mut Market,
    rules: &Rules,
    l: &mut Ledger,
    expiry: u64,
    ts: u64,
    block: u64,
) {
    for i in 0..m.pools.len() {
        if m.pools[i].key.expiry == expiry {
            let _ = m.settle(i, rules, l, ts, block);
        }
    }
}

fn finish(m: &mut Market, rules: &Rules, l: &mut Ledger, expiry: u64, block: u64, ref_price: f64) {
    for i in 0..m.pools.len() {
        if m.pools[i].key.expiry == expiry {
            let _ = m.mature(i, expiry, block);
            // rational borrowers (accounts 1..=20) repay only if the asset is worth more than K
            let k = m.pools[i].key.strike;
            if (ref_price * USDC as f64) as u128 > k {
                for a in 1..=20u32 {
                    let r = m.pools[i].free_r(a);
                    if r != 0 {
                        l.withdraw_quote(a);
                        let _ = m.repay(i, rules, l, a, r, expiry, block + 1);
                    }
                }
            }
        }
    }
    for i in 0..m.pools.len() {
        if m.pools[i].key.expiry == expiry {
            let _ = m.close(i, rules, l, block + WINDOW_BLOCKS);
            for a in 1..=20u32 {
                let _ = m.pools[i].claim(l, a);
            }
        }
    }
}

pub fn run() {
    let paths: [(&str, f64); 3] = [("bull", 0.012), ("flat", 0.0), ("bear", -0.012)];
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for (path, drift) in paths {
            for (tier_name, tier) in [("low", VaultTier::Low), ("high", VaultTier::High)] {
                for guard in [false, true] {
                    if rules.name() == "v07" && guard {
                        continue;
                    }
                    let mut rng = ChaCha8Rng::seed_from_u64(7);
                    let mut m = Market::new(grid(), 18, true);
                    let mut l = Ledger::default();
                    for a in 1..=40u32 {
                        l.mint_quote(a, 1_000_000_000 * USDC);
                        l.mint_asset(a, 1_000_000 * ETH);
                    }
                    for a in 100..=110u32 {
                        l.mint_quote(a, 1_000_000 * USDC);
                    }
                    let mut vault = Vault::new(VAULT, tier, if guard { Some(800) } else { None });
                    let expiries: Vec<u64> = (1..=8).map(|i| i * 7 * DAY).collect();
                    let mut ref_price = 3450.0f64;
                    // history: 4 expiries, flat market
                    seed_history(&mut m, &rules, &mut l, &expiries[..4], &mut rng, ref_price);
                    for (ei, &e) in expiries[..4].iter().enumerate() {
                        settle_all_open(&mut m, &rules, &mut l, e, e - DAY, 1000 * (ei as u64 + 1));
                        finish(
                            &mut m,
                            &rules,
                            &mut l,
                            e,
                            10_000 * (ei as u64 + 1),
                            ref_price,
                        );
                        m.check_graduation(&rules, 4);
                    }
                    assert!(m.graduated, "history must graduate ({})", rules.name());
                    // depositors come in
                    for a in 100..=110u32 {
                        vault.request_deposit(&mut l, a, 500_000 * USDC).unwrap();
                    }
                    vault.roll(
                        &mut m,
                        &mut l,
                        (ref_price * USDC as f64) as u128,
                        expiries[3],
                    );
                    // four invested expiries with the chosen price path
                    for ei in 4..8 {
                        let e = expiries[ei];
                        let prev = expiries[ei - 1];
                        ref_price *= 1.0 + drift * 7.0 / 7.0 * 1.0;
                        let mark = (ref_price * USDC as f64) as u128;
                        // honest book for this expiry, refreshed every batch
                        seed_history(&mut m, &rules, &mut l, &[e], &mut rng, ref_price);
                        let mut invested = 0u128;
                        let mut target = None;
                        for b in 0..6u64 {
                            if b > 0 {
                                for k in STRIKES {
                                    let idx = m.pool_at(e, k * USDC).unwrap();
                                    let price = (((ref_price
                                        * (1.0 - rng.random_range(0.005..0.02)))
                                        * USDC as f64)
                                        as u128)
                                        .min(k * USDC - USDC);
                                    let units = 100_000 * USDC * ETH / price;
                                    let _ = m.pools[idx].place(
                                        &rules,
                                        &mut l,
                                        1,
                                        Side::Sell,
                                        units,
                                        price,
                                        0,
                                        1,
                                    );
                                    let _ = m.pools[idx].place(
                                        &rules,
                                        &mut l,
                                        2,
                                        Side::Buy,
                                        units,
                                        price,
                                        0,
                                        1,
                                    );
                                }
                            }
                            let before = l.quote_of(VAULT);
                            if let Some(t) = vault.poke(&mut m, &rules, &mut l, e, prev) {
                                target = Some(m.pools[t].key.strike);
                                invested += before - l.quote_of(VAULT);
                            }
                            settle_all_open(
                                &mut m,
                                &rules,
                                &mut l,
                                e,
                                e - 2 * DAY + (b + 1) * BATCH,
                                100_000 * ei as u64 + b,
                            );
                        }
                        // one depositor asks to leave each expiry
                        let who = 100 + (ei as u32 - 4);
                        let sh = *vault.shares.get(&who).unwrap_or(&0);
                        if sh != 0 {
                            vault.request_redeem(&m, &l, who, sh, mark).unwrap();
                        }
                        finish(
                            &mut m,
                            &rules,
                            &mut l,
                            e,
                            100_000 * ei as u64 + 50,
                            ref_price,
                        );
                        // auto-sell (v0.8): defaulted asset goes into the next expiry's same-strike pool
                        vault.roll(&mut m, &mut l, mark, e);
                        if rules.name() == "v08" {
                            if let (Some(k), Some(next_e)) = (target, expiries.get(ei + 1)) {
                                if m.pool_at(*next_e, k).is_none() {
                                    let idx = m.create_pool(*next_e, k, 800, 0, 0);
                                    m.pools[idx].auto_sell = true;
                                }
                                let np = m.pool_at(*next_e, k).unwrap();
                                vault.auto_sell(&mut m, &rules, &mut l, np, 300);
                            }
                        }
                        m.check_invariants(&l).unwrap();
                        rows.push(Row {
                            rules: rules.name(),
                            path,
                            tier: tier_name,
                            guard,
                            expiry_index: ei,
                            ref_price,
                            target_strike: target.map(usdc),
                            invested_this_expiry: usdc(invested),
                            nav_per_share: vault.nav_per_share(&m, &l, mark),
                            quote_wallet: usdc(l.quote_of(VAULT)),
                            asset_for_sale_eth: eth(vault.asset_for_sale),
                            asset_fallback_eth: eth(l.asset_of(VAULT) + l.pending_asset_of(VAULT)),
                            redeem_queue_len: vault.redeem_queue.len(),
                            redeemed_total: usdc(vault.redeemed_total),
                        });
                    }
                }
            }
        }
    }
    write_csv("earn.csv", &rows);
    threshold_buyer();
}

/// ❌ BLUEPRINT §5: a buyer that only bids when the implied APR ≥ X%. It buys most exactly when prices fall.
fn threshold_buyer() {
    let rules = Rules::v08();
    let k = 3400 * USDC;
    let expiry = 7 * DAY;
    let mut rows = Vec::new();
    for (path, drift) in [("bull", 0.004f64), ("flat", 0.0), ("bear", -0.004)] {
        for thr in [0.0f64, 0.5, 1.0, 2.0] {
            let mut rng = ChaCha8Rng::seed_from_u64(11);
            let (mut m, mut l) = fresh(&rules, k, expiry, 800, 10);
            let mut ref_price = 3350.0f64;
            let buyer = 9;
            let (mut bought_b, mut units, mut paid) = (0u32, 0u128, 0u128);
            for b in 0..(expiry / BATCH) {
                ref_price *= 1.0 + drift + rng.random_range(-0.004..0.004);
                let rp = (ref_price * USDC as f64) as u128;
                let p = &mut m.pools[0];
                // competitive book around the reference, below K
                let lim_s = (rp as f64 * 0.995) as u128;
                let lim_b = ((rp as f64 * 0.997) as u128).min(k - USDC);
                p.place(&rules, &mut l, 1, Side::Sell, 10 * ETH, lim_s, 0, 1)
                    .unwrap();
                p.place(&rules, &mut l, 2, Side::Buy, 10 * ETH, lim_b, 0, 1)
                    .unwrap();
                // threshold buyer: implied APR at the expected P* (midpoint)
                let exp_p = (lim_s + lim_b) / 2;
                if exp_p < k && apr(exp_p, k, 7.0 - b as f64 / 48.0) >= thr {
                    // bids one tick above the resting lender so it is first in the book
                    p.place(
                        &rules,
                        &mut l,
                        buyer,
                        Side::Buy,
                        10 * ETH,
                        (lim_b + USDC).min(k - 1),
                        0,
                        1,
                    )
                    .unwrap();
                }
                let rep = m.settle(0, &rules, &mut l, (b + 1) * BATCH, b).unwrap();
                if rep.traded {
                    let f: u128 = m.pools[0]
                        .fills
                        .iter()
                        .filter(|f| f.owner == buyer && f.settle_index == rep.settle_index)
                        .map(|f| f.units)
                        .sum();
                    if f != 0 {
                        bought_b += 1;
                        units += f;
                        paid += confluere_model::math::quote_up(f, rep.price, ETH);
                    }
                }
            }
            let final_ref = ref_price;
            let defaulted = (final_ref * USDC as f64) as u128 <= k;
            m.mature(0, expiry, 10_000).unwrap();
            if !defaulted {
                l.withdraw_quote(1);
                let r = m.pools[0].free_r(1);
                m.repay(0, &rules, &mut l, 1, r, expiry, 10_001).unwrap();
            }
            m.close(0, &rules, &mut l, 10_000 + WINDOW_BLOCKS).unwrap();
            let (q, a) = m.pools[0].claim(&mut l, buyer).unwrap();
            let value = q as f64 + a as f64 * final_ref * USDC as f64 / ETH as f64;
            rows.push(ThresholdRow {
                path,
                apr_threshold: thr,
                batches_bought: bought_b,
                units_bought: eth(units),
                avg_price: if units == 0 {
                    0.0
                } else {
                    paid as f64 / units as f64 * ETH as f64 / USDC as f64
                },
                final_ref_price: final_ref,
                defaulted_share: if defaulted { 1.0 } else { 0.0 },
                pnl_usdc: (value - paid as f64) / USDC as f64,
            });
        }
    }
    write_csv("earn_threshold_buyer.csv", &rows);
}
