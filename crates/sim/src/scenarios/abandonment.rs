//! Abandonment auction (BLUEPRINT §3.5): forgetful borrowers, bidders escrow K + premium, close ranks by
//! premium. Residual value returned to R holders vs a naive default, and bidder refunds via `pending`.
//! One case is replayed in revm (bid, closeWindow, claim) and compared with the model.

use crate::common::*;
use alloy_primitives::U256;
use confluere_evm::{addr, GridConfig, Harness, BUY, SELL};
use confluere_model::{Rules, Side};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    unrepaid_eth: f64,
    market_price: f64,
    bidders: usize,
    bid_units_total_eth: f64,
    units_taken_by_bids_eth: f64,
    units_defaulted_eth: f64,
    premium_to_r_holders_usdc: f64,
    r_holder_recovery_pct_of_residual: f64,
    bidder_refunds_usdc: f64,
    c_holder_quote_usdc: f64,
    c_holder_asset_eth: f64,
}

pub fn run() {
    let k = 3400 * USDC;
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for market_price in [3300u128, 3450, 3600, 4000] {
            for bidders in [0usize, 1, 3, 8] {
                let (mut m, mut l) = fresh(&rules, k, 7 * DAY, 800, 20);
                let unrepaid = 10 * ETH;
                m.pools[0]
                    .place(&rules, &mut l, 1, Side::Sell, unrepaid, 3300 * USDC, 0, 2)
                    .unwrap();
                m.pools[0]
                    .place(&rules, &mut l, 2, Side::Buy, unrepaid, 3300 * USDC, 0, 2)
                    .unwrap();
                m.settle(0, &rules, &mut l, BATCH, 1).unwrap();
                m.mature(0, 7 * DAY, 10_000).unwrap();
                // the borrower forgets; bidders value the asset at market_price and bid part of (market − K)
                let residual = (market_price * USDC).saturating_sub(k); // per ETH, in quote
                let mut bid_units = 0u128;
                for i in 0..bidders {
                    let who = 10 + i as u32;
                    let share = (i as u128 + 1) * 100 / (bidders as u128 + 1); // 1/(n+1) … n/(n+1) of residual
                    let premium = residual * share / 100;
                    let units = if bidders == 1 { unrepaid } else { unrepaid / 2 };
                    m.pools[0].bid(&mut l, who, units, premium, 10_500).unwrap();
                    bid_units += units;
                }
                m.close(0, &rules, &mut l, 10_000 + WINDOW_BLOCKS).unwrap();
                let p = &m.pools[0];
                let taken = unrepaid - p.asset_bal;
                let surplus = p.surplus_bal;
                let refunds: u128 = (10..10 + bidders as u32)
                    .map(|a| l.pending_quote_of(a))
                    .sum();
                let residual_total = quote_down_f(unrepaid, residual);
                rows.push(Row {
                    rules: rules.name(),
                    unrepaid_eth: eth(unrepaid),
                    market_price: market_price as f64,
                    bidders,
                    bid_units_total_eth: eth(bid_units),
                    units_taken_by_bids_eth: eth(taken),
                    units_defaulted_eth: eth(p.asset_bal),
                    premium_to_r_holders_usdc: usdc(surplus),
                    r_holder_recovery_pct_of_residual: if residual_total == 0.0 {
                        0.0
                    } else {
                        usdc(surplus) / residual_total * 100.0
                    },
                    bidder_refunds_usdc: usdc(refunds),
                    c_holder_quote_usdc: usdc(p.quote_bal),
                    c_holder_asset_eth: eth(p.asset_bal),
                });
                m.check_invariants(&l).unwrap();
            }
        }
    }
    write_csv("abandonment.csv", &rows);
    revm_check();
}

fn quote_down_f(units: u128, price: u128) -> f64 {
    units as f64 / ETH as f64 * price as f64 / USDC as f64
}

/// Same shape on the real bytecode: 10 ETH unrepaid, two bidders (premium 50 and 150 USDC/ETH, 5 ETH each),
/// a third over-bidder for 20 ETH at 10 USDC/ETH that only gets the leftovers → none.
fn revm_check() {
    let gc = GridConfig {
        anchor: 0,
        period: 7 * DAY,
        batchInterval: BATCH,
        maxExpiries: 4,
        strikeSigDigits: 2,
    };
    let mut h = Harness::new(gc, 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
    let (b, le, b1, b2, b3) = (addr(1), addr(2), addr(11), addr(12), addr(13));
    for a in [b, le, b1, b2, b3] {
        h.mint(h.asset, a, U256::from(100 * ETH)).unwrap();
        h.mint(h.quote, a, U256::from(10_000_000 * USDC)).unwrap();
    }
    let k = 3400 * USDC;
    let pool = h.create_pool(b, 7 * DAY, k, true, 1000, 800).unwrap();
    h.place(b, pool, SELL, 10 * ETH, 3300 * USDC, 0, 2).unwrap();
    h.place(le, pool, BUY, 10 * ETH, 3300 * USDC, 0, 2).unwrap();
    h.warp(BATCH, 10);
    h.settle(pool).unwrap();
    h.warp(7 * DAY, 10_000);
    h.mature(pool).unwrap();
    h.warp(7 * DAY + 60, 10_500);
    h.bid(b1, pool, 5 * ETH, 50 * USDC).unwrap();
    h.bid(b2, pool, 5 * ETH, 150 * USDC).unwrap();
    h.bid(b3, pool, 20 * ETH, 10 * USDC).unwrap();
    h.warp(7 * DAY + WINDOW_BLOCKS, 10_000 + WINDOW_BLOCKS);
    assert!(h.close_window(pool).unwrap());
    let v = h.pool_view(pool).unwrap();
    let surplus_evm: u128 = v.surplusBal.to();
    let b3_refund: u128 = h.pending(h.quote, b3).unwrap().to();
    let b1_asset: u128 = h.pending(h.asset, b1).unwrap().to();
    // model
    let rules = Rules::v07();
    let (mut m, mut l) = fresh(&rules, k, 7 * DAY, 800, 20);
    m.pools[0]
        .place(&rules, &mut l, 1, Side::Sell, 10 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    m.pools[0]
        .place(&rules, &mut l, 2, Side::Buy, 10 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    m.settle(0, &rules, &mut l, BATCH, 10).unwrap();
    m.mature(0, 7 * DAY, 10_000).unwrap();
    m.pools[0]
        .bid(&mut l, 11, 5 * ETH, 50 * USDC, 10_500)
        .unwrap();
    m.pools[0]
        .bid(&mut l, 12, 5 * ETH, 150 * USDC, 10_500)
        .unwrap();
    m.pools[0]
        .bid(&mut l, 13, 20 * ETH, 10 * USDC, 10_500)
        .unwrap();
    m.close(0, &rules, &mut l, 10_000 + WINDOW_BLOCKS).unwrap();
    println!(
        "abandonment revm: surplus {} vs model {}; b3 refund {} vs {}; b1 asset {} vs {}",
        usdc(surplus_evm),
        usdc(m.pools[0].surplus_bal),
        usdc(b3_refund),
        usdc(l.pending_quote_of(13)),
        eth(b1_asset),
        eth(l.pending_asset_of(11))
    );
    assert_eq!(surplus_evm, m.pools[0].surplus_bal);
    assert_eq!(b3_refund, l.pending_quote_of(13));
    assert_eq!(b1_asset, l.pending_asset_of(11));
    // R holder claims the premium
    let (q_evm, _) = h.claim(b, pool).unwrap();
    let (q_model, _) = m.pools[0].claim(&mut l, 1).unwrap();
    assert_eq!(q_evm, U256::from(q_model), "R holder premium claim");
}
