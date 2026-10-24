//! AUDIT M-2: wash trading drags the pool VWAP to K and zeroes everyone's spread share under v0.7.
//! Under v0.8 each fill carries its own fee and the attacker pays the 0.03% trade fee on the wash volume.
//! The attacker never repays: holding both R and C of the wash units, defaulting returns the asset via C.

use crate::common::*;
use confluere_model::{Rules, Side, TREASURY};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    honest_units: f64,
    wash_multiple: f64,
    wash_units: f64,
    honest_price: f64,
    wash_price: f64,
    vwap: f64,
    protocol_fee_total: f64,
    protocol_fee_without_wash: f64,
    fee_lost_pct: f64,
    attacker_pnl_usdc: f64,
    honest_lender_pnl_usdc: f64,
    attacker_pnl_per_fee_lost: f64,
}

pub fn run() {
    let k = 3400 * USDC;
    let expiry = 7 * DAY;
    let honest_units = 100 * ETH;
    let honest_price = 3300 * USDC;
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08(), Rules::v08_tranche()] {
        let baseline_fee = simulate(&rules, k, expiry, honest_units, honest_price, 0).0;
        for mult in [0.0, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0] {
            let wash = (honest_units as f64 * mult) as u128;
            let (fee, attacker_pnl, lender_pnl, vwap, wash_price) =
                simulate(&rules, k, expiry, honest_units, honest_price, wash);
            let lost = if baseline_fee == 0 {
                0.0
            } else {
                1.0 - fee as f64 / baseline_fee as f64
            };
            rows.push(Row {
                rules: rules.name(),
                honest_units: eth(honest_units),
                wash_multiple: mult,
                wash_units: eth(wash),
                honest_price: usdc(honest_price),
                wash_price: usdc(wash_price),
                vwap: usdc(vwap),
                protocol_fee_total: usdc(fee),
                protocol_fee_without_wash: usdc(baseline_fee),
                fee_lost_pct: lost * 100.0,
                attacker_pnl_usdc: attacker_pnl / USDC as f64,
                honest_lender_pnl_usdc: lender_pnl / USDC as f64,
                attacker_pnl_per_fee_lost: if baseline_fee > fee {
                    attacker_pnl / (baseline_fee - fee) as f64
                } else {
                    f64::NAN
                },
            });
        }
    }
    write_csv("fee_wash.csv", &rows);
}

/// Returns (treasury fee, attacker P&L, honest lender P&L, final vwap, wash price). P&L values the asset at
/// `honest_price` (the market) and the lender's P&L is against the K they were owed.
fn simulate(
    rules: &Rules,
    k: u128,
    expiry: u64,
    honest_units: u128,
    honest_price: u128,
    wash_units: u128,
) -> (u128, f64, f64, u128, u128) {
    let (mut m, mut l) = fresh(rules, k, expiry, 800, 4);
    let borrower = 1;
    let lender = 2;
    let attacker = 3;
    let value = |l: &confluere_model::Ledger, a: u32| {
        l.quote_of(a) as f64 + l.asset_of(a) as f64 * honest_price as f64 / ETH as f64
    };
    let attacker_start = value(&l, attacker);
    let lender_start = value(&l, lender);
    let p = &mut m.pools[0];
    // batch 1: honest trade at honest_price (both limits equal → P* = that price)
    p.place(
        rules,
        &mut l,
        borrower,
        Side::Sell,
        honest_units,
        honest_price,
        0,
        2,
    )
    .unwrap();
    p.place(
        rules,
        &mut l,
        lender,
        Side::Buy,
        honest_units,
        honest_price,
        0,
        2,
    )
    .unwrap();
    p.settle(rules, &mut l, BATCH, 1).unwrap();
    // batch 2: attacker self-trades just below K
    let wash_price = k - USDC;
    if wash_units != 0 {
        p.place(
            rules,
            &mut l,
            attacker,
            Side::Sell,
            wash_units,
            wash_price,
            0,
            2,
        )
        .unwrap();
        p.place(
            rules,
            &mut l,
            attacker,
            Side::Buy,
            wash_units,
            wash_price,
            0,
            2,
        )
        .unwrap();
        p.settle(rules, &mut l, 2 * BATCH, 2).unwrap();
    }
    let vwap = p.vwap();
    // expiry: the honest borrower repays; the attacker holds both R and C of the wash units and simply
    // defaults — the C side hands the asset straight back, so the R side never pays K or any fee.
    p.mature(expiry, 1000, None).unwrap();
    l.withdraw_quote(borrower);
    l.withdraw_quote(attacker);
    p.repay(rules, &mut l, borrower, honest_units, 1001)
        .unwrap();
    p.close(rules, &mut l, 1000 + WINDOW_BLOCKS).unwrap();
    p.claim(&mut l, lender).unwrap();
    if wash_units != 0 {
        p.claim(&mut l, attacker).unwrap();
    }
    for a in [lender, attacker] {
        l.withdraw_quote(a);
        l.withdraw_asset(a);
    }
    m.check_invariants(&l).unwrap();
    let fee = l.pending_quote_of(TREASURY);
    let attacker_pnl = value(&l, attacker) - attacker_start;
    // the honest lender paid honest_price × units and was owed K × units
    let lender_pnl = value(&l, lender)
        - lender_start
        - (k - honest_price) as f64 * honest_units as f64 / ETH as f64;
    (fee, attacker_pnl, lender_pnl, vwap, wash_price)
}
