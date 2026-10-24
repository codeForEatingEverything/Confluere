//! Rollover bridge (BLUEPRINT §3.7): success vs top-up size and next-pool depth across the window's batches,
//! the v0.8 "last batch before expiry" rule for long-tail pools, and the void path when the old window has
//! already closed. One case is replayed on the real bytecode in revm to confirm the model's accounting.

use crate::common::*;
use alloy_primitives::U256;
use confluere_evm::{addr, GridConfig, Harness, BUY, SELL};
use confluere_model::{Rules, Side};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    cadence: u8,
    next_depth_eth: f64,
    next_price: f64,
    top_up_offered: f64,
    needed_top_up: f64,
    filled_batch: i32,
    filled_units: f64,
    outcome: &'static str,
    old_pool_repaid_eth: f64,
    borrower_refund: f64,
}

pub fn run() {
    let k = 3400 * USDC;
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for cadence in [0u8, 2] {
            for depth in [5u128, 10, 20] {
                for next_price in [3250u128, 3300, 3380] {
                    for top_up_mult in [0.0f64, 0.5, 1.0, 2.0] {
                        let mut m = confluere_model::Market::new(grid(), 18, true);
                        let mut l = confluere_model::Ledger::default();
                        for a in 1..=4 {
                            l.mint_quote(a, 10_000_000 * USDC);
                            l.mint_asset(a, 1000 * ETH);
                        }
                        let old = m.create_pool(7 * DAY, k, 800, cadence, 0);
                        let new = m.create_pool(14 * DAY, k, 800, cadence, 0);
                        let (borrower, lender, lender2) = (1, 2, 3);
                        // old pool: 10 ETH at 3300
                        m.pools[old]
                            .place(
                                &rules,
                                &mut l,
                                borrower,
                                Side::Sell,
                                10 * ETH,
                                3300 * USDC,
                                0,
                                2,
                            )
                            .unwrap();
                        m.pools[old]
                            .place(
                                &rules,
                                &mut l,
                                lender,
                                Side::Buy,
                                10 * ETH,
                                3300 * USDC,
                                0,
                                2,
                            )
                            .unwrap();
                        let iv = m.pools[old].interval();
                        m.settle(old, &rules, &mut l, iv, 1).unwrap();
                        // next pool depth at next_price
                        m.pools[new]
                            .place(
                                &rules,
                                &mut l,
                                lender2,
                                Side::Buy,
                                depth * ETH,
                                next_price * USDC,
                                0,
                                40,
                            )
                            .unwrap();
                        // rollover: min price = next_price − 50, top-up = mult × worst-case gap
                        let min_price = (next_price - 50) * USDC;
                        let need =
                            confluere_model::math::quote_up(10 * ETH, k - min_price, ETH) + 2 * 10;
                        let offered = (need as f64 * top_up_mult) as u128;
                        let r = m.rollover(
                            old,
                            new,
                            &mut l,
                            borrower,
                            10 * ETH,
                            min_price,
                            offered,
                            10,
                            6 * DAY,
                            500,
                        );
                        if r.is_err() {
                            rows.push(Row {
                                rules: rules.name(),
                                cadence,
                                next_depth_eth: depth as f64,
                                next_price: next_price as f64,
                                top_up_offered: usdc(offered),
                                needed_top_up: usdc(need),
                                filled_batch: -1,
                                filled_units: 0.0,
                                outcome: "rejected_insufficient_top_up",
                                old_pool_repaid_eth: 0.0,
                                borrower_refund: 0.0,
                            });
                            continue;
                        }
                        // batches: last one before expiry, then window batches until the window ends
                        let mut filled_batch = -1i32;
                        let mut batch_no = 0i32;
                        let expiry = 7 * DAY;
                        let mut block = 1000u64;
                        // last pre-expiry batch of the new pool
                        let ts_last = expiry - iv;
                        if let Ok(rep) = m.settle(new, &rules, &mut l, ts_last, block) {
                            if rep.traded && m.pools[old].repaid_units != 0 {
                                filled_batch = 0;
                            }
                        }
                        m.mature(old, expiry, block).unwrap();
                        let wend = m.window_end(expiry).unwrap();
                        let mut ts = expiry;
                        while block < wend && filled_batch < 0 {
                            ts += iv;
                            block += (iv / 1) * 1 / 1; // 1 s blocks
                            batch_no += 1;
                            if block >= wend {
                                break;
                            }
                            if let Ok(rep) = m.settle(new, &rules, &mut l, ts, block) {
                                if rep.traded && m.pools[old].repaid_units != 0 {
                                    filled_batch = batch_no;
                                }
                            }
                        }
                        // window over: close old; void rollover refunds on the next new-pool settle / purge
                        m.close(old, &rules, &mut l, wend).unwrap();
                        let _ = m.settle(new, &rules, &mut l, ts + iv, wend + 10);
                        let refund = l.pending_quote_of(borrower);
                        m.check_invariants(&l).unwrap();
                        let outcome = if filled_batch == 0 {
                            "filled_last_pre_expiry_batch"
                        } else if filled_batch > 0 {
                            "filled_in_window"
                        } else if depth < 10 {
                            "defaulted_thin_book"
                        } else {
                            "defaulted_price_below_min"
                        };
                        rows.push(Row {
                            rules: rules.name(),
                            cadence,
                            next_depth_eth: depth as f64,
                            next_price: next_price as f64,
                            top_up_offered: usdc(offered),
                            needed_top_up: usdc(need),
                            filled_batch,
                            filled_units: eth(m.pools[new].r_of(borrower)),
                            outcome,
                            old_pool_repaid_eth: eth(m.pools[old].repaid_units),
                            borrower_refund: usdc(refund),
                        });
                    }
                }
            }
        }
    }
    write_csv("rollover.csv", &rows);
    revm_check();
}

/// Replay one rollover on the real contracts: 10 ETH @3300 in the old pool, next pool buyer at 3300,
/// rollover fills in the window; the old pool must show K paid and the new pool the new R.
fn revm_check() {
    let gc = GridConfig {
        anchor: 0,
        period: 7 * DAY,
        batchInterval: BATCH,
        maxExpiries: 4,
        strikeSigDigits: 2,
    };
    let mut h = Harness::new(gc, 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
    let (b, le, le2) = (addr(1), addr(2), addr(3));
    for a in [b, le, le2] {
        h.mint(h.asset, a, U256::from(1000 * ETH)).unwrap();
        h.mint(h.quote, a, U256::from(10_000_000 * USDC)).unwrap();
    }
    let k = 3400 * USDC;
    let old = h.create_pool(b, 7 * DAY, k, true, 1000, 800).unwrap();
    let new = h.create_pool(b, 14 * DAY, k, true, 1000, 800).unwrap();
    h.place(b, old, SELL, 10 * ETH, 3300 * USDC, 0, 2).unwrap();
    h.place(le, old, BUY, 10 * ETH, 3300 * USDC, 0, 2).unwrap();
    h.warp(BATCH, 10);
    h.settle(old).unwrap();
    h.place(le2, new, BUY, 10 * ETH, 3300 * USDC, 0, 40)
        .unwrap();
    let need = (k - 3250 * USDC) * 10 + 2 * 10;
    h.warp(6 * DAY, 500);
    h.rollover(b, old, new, 10 * ETH, 3250 * USDC, need, 10)
        .unwrap();
    // the rollover is not live before the old expiry under v0.7
    h.warp(7 * DAY - BATCH, 900);
    h.settle(new).unwrap();
    let r_new_early: u128 = h.position(b, new, true).unwrap().to();
    h.warp(7 * DAY, 1000);
    h.mature(old).unwrap();
    h.warp(7 * DAY + BATCH, 1100);
    h.settle(new).unwrap();
    let r_new: u128 = h.position(b, new, true).unwrap().to();
    let r_old: u128 = h.position(b, old, true).unwrap().to();
    let old_view = h.pool_view(old).unwrap();
    // model, same steps
    let rules = Rules::v07();
    let mut m = confluere_model::Market::new(grid(), 18, true);
    let mut l = confluere_model::Ledger::default();
    for a in 1..=3 {
        l.mint_quote(a, 10_000_000 * USDC);
        l.mint_asset(a, 1000 * ETH);
    }
    let mo = m.create_pool(7 * DAY, k, 800, 0, 0);
    let mn = m.create_pool(14 * DAY, k, 800, 0, 0);
    m.pools[mo]
        .place(&rules, &mut l, 1, Side::Sell, 10 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    m.pools[mo]
        .place(&rules, &mut l, 2, Side::Buy, 10 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    m.settle(mo, &rules, &mut l, BATCH, 10).unwrap();
    m.pools[mn]
        .place(&rules, &mut l, 3, Side::Buy, 10 * ETH, 3300 * USDC, 0, 40)
        .unwrap();
    m.rollover(
        mo,
        mn,
        &mut l,
        1,
        10 * ETH,
        3250 * USDC,
        need,
        10,
        6 * DAY,
        500,
    )
    .unwrap();
    m.settle(mn, &rules, &mut l, 7 * DAY - BATCH, 900).unwrap();
    m.mature(mo, 7 * DAY, 1000).unwrap();
    m.settle(mn, &rules, &mut l, 7 * DAY + BATCH, 1100).unwrap();
    let quote_bal_evm: u128 = old_view.quoteBal.to();
    println!(
        "rollover revm: early R(new) {} | after window batch R(new) {} R(old) {} old.quoteBal {} | model R(new) {} R(old) {} old.quote_bal {}",
        eth(r_new_early), eth(r_new), eth(r_old), usdc(quote_bal_evm), eth(m.pools[mn].r_of(1)), eth(m.pools[mo].r_of(1)), usdc(m.pools[mo].quote_bal)
    );
    assert_eq!(
        r_new_early, 0,
        "v0.7 rollover must not fill before the old expiry"
    );
    assert_eq!(r_new, m.pools[mn].r_of(1));
    assert_eq!(r_old, m.pools[mo].r_of(1));
    assert_eq!(
        quote_bal_evm, m.pools[mo].quote_bal,
        "old pool quote after rollover repay"
    );
}
