//! Section 1 "Looping" and section 2 "Loop's edge cases" (BLUEPRINT §7.1): LST / native pair, American pool,
//! K = 0.98 of par. The looper sells LST into the pool, converts the native proceeds back into LST at the
//! exchange rate (staking is 1:1 at the rate; assumed instant) and sells again. Edge cases: depeg at expiry,
//! partial repay, running out of quote mid-unwind, rollover across two expiries.

use crate::common::*;
use confluere_model::{Market, Rules, Side};
use serde::Serialize;

const ONE: u128 = ETH; // 18-dp native
const K: u128 = 980_000_000_000_000_000; // 0.98 native per LST (18 dp)

#[derive(Serialize)]
struct LoopRow {
    rules: &'static str,
    loops: u32,
    lender_depth_lst: f64,
    lst_start: f64,
    lst_exposure: f64,
    leverage: f64,
    native_borrowed: f64,
    discount_cost_native: f64,
    fees_paid_native: f64,
    repay_due_native: f64,
    breakeven_rate_move_pct: f64,
    outcome_if_default_native: f64,
}

#[derive(Serialize)]
struct EdgeRow {
    rules: &'static str,
    case: &'static str,
    detail: String,
    looper_pnl_native: f64,
    lender_pnl_native: f64,
    ok: bool,
}

fn market(rules: &Rules, depth: u128, accounts: u32) -> (Market, confluere_model::Ledger) {
    let mut m = Market::new(grid(), 18, true);
    m.create_pool(7 * DAY, K, 150, 0, 0);
    let mut l = confluere_model::Ledger::default();
    for a in 1..=accounts {
        l.mint_quote(a, 1_000_000 * ONE);
        l.mint_asset(a, 1_000_000 * ONE);
    }
    let _ = (rules, depth);
    (m, l)
}

/// One loop: sell `lst` at the lender's price, receive native, convert at `rate` (native per LST) into LST.
fn one_loop(
    m: &mut Market,
    rules: &Rules,
    l: &mut confluere_model::Ledger,
    looper: u32,
    lender: u32,
    lst: u128,
    price: u128,
    batch: u64,
    rate: f64,
) -> (u128, u128, u128) {
    let p = &mut m.pools[0];
    p.place(rules, l, looper, Side::Sell, lst, price, 0, 1)
        .unwrap();
    p.place(rules, l, lender, Side::Buy, lst, price, 0, 1)
        .unwrap();
    let before = l.pending_quote_of(looper);
    let rep = m.settle(0, rules, l, (batch + 1) * BATCH, batch).unwrap();
    let got = l.pending_quote_of(looper) - before;
    l.withdraw_quote(looper);
    // stake: native → LST at the exchange rate (1 LST = rate native)
    let new_lst = (got as f64 / rate) as u128;
    *l.quote.get_mut(&looper).unwrap() -= got;
    l.mint_asset(looper, new_lst);
    (got, new_lst, rep.price)
}

pub fn run() {
    let rate = 1.02f64; // 1 LST = 1.02 native
    let price = 970_000_000_000_000_000u128; // sells at 0.97 native per LST (1% below K)
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for depth in [50u128, 500] {
            for loops in 1..=8u32 {
                let (mut m, mut l) = market(&rules, depth, 4);
                let looper = 1;
                let lender = 2;
                let start = 100 * ONE;
                let mut lst_held = start;
                let mut borrowed = 0u128;
                let mut sold_total = 0u128;
                let mut fees = 0u128;
                for i in 0..loops {
                    let lst = lst_held.min(depth * ONE);
                    if lst == 0 {
                        break;
                    }
                    let fee_before = m.pools[0].fees_to_treasury + m.pools[0].fee_escrow;
                    let (got, new_lst, _) = one_loop(
                        &mut m, &rules, &mut l, looper, lender, lst, price, i as u64, rate,
                    );
                    fees += m.pools[0].fees_to_treasury + m.pools[0].fee_escrow - fee_before;
                    borrowed += got;
                    sold_total += lst;
                    lst_held = lst_held - lst + new_lst;
                }
                let exposure = sold_total + lst_held; // LST in pool (borrowed against) + LST still in hand
                let repay_due = confluere_model::math::repay_amount(sold_total, K, ONE);
                let discount_cost = repay_due - borrowed; // interest: K − P on everything sold
                                                          // break-even: exposure × rate_new − repay_due = start × rate → solve rate_new
                let be_rate = (start as f64 * rate + repay_due as f64) / exposure as f64;
                rows.push(LoopRow {
                    rules: rules.name(),
                    loops,
                    lender_depth_lst: depth as f64,
                    lst_start: eth(start),
                    lst_exposure: eth(exposure),
                    leverage: exposure as f64 / start as f64,
                    native_borrowed: eth(borrowed),
                    discount_cost_native: eth(discount_cost),
                    fees_paid_native: eth(fees),
                    repay_due_native: eth(repay_due),
                    breakeven_rate_move_pct: (be_rate / rate - 1.0) * 100.0,
                    // default: keep the native borrowed and the LST in hand, lose the LST in the pool
                    outcome_if_default_native: eth(borrowed) + eth(lst_held) * rate
                        - eth(start) * rate,
                });
                m.check_invariants(&l).unwrap();
            }
        }
    }
    write_csv("loop.csv", &rows);
    edges(rate, price);
}

fn edges(rate: f64, price: u128) {
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        // 1. depeg below K at expiry: the rational looper defaults, the lender holds LST worth < K
        {
            let (mut m, mut l) = market(&rules, 500, 4);
            let (looper, lender) = (1, 2);
            let v0_l = l.quote_of(looper) as f64 + l.asset_of(looper) as f64 * rate;
            let v0_len = l.quote_of(lender) as f64 + l.asset_of(lender) as f64 * rate;
            let mut lst = 100 * ONE;
            for i in 0..3 {
                let (_, new_lst, _) =
                    one_loop(&mut m, &rules, &mut l, looper, lender, lst, price, i, rate);
                lst = new_lst;
            }
            let depeg = 0.95f64; // 1 LST = 0.95 native < K
            m.mature(0, 7 * DAY, 10_000).unwrap();
            // rational: K per LST (0.98) > market (0.95) → default
            m.close(0, &rules, &mut l, 10_000 + WINDOW_BLOCKS).unwrap();
            m.pools[0].claim(&mut l, lender).unwrap();
            l.withdraw_quote(looper);
            let v1_l = l.quote_of(looper) as f64 + l.asset_of(looper) as f64 * depeg;
            let v1_len = l.quote_of(lender) as f64 + l.asset_of(lender) as f64 * depeg;
            rows.push(EdgeRow {
                rules: rules.name(),
                case: "depeg_default",
                detail: "LST at 0.95 < K 0.98 at expiry; looper defaults, lender keeps LST".into(),
                looper_pnl_native: (v1_l - v0_l) / ONE as f64,
                lender_pnl_native: (v1_len - v0_len) / ONE as f64,
                ok: m.check_invariants(&l).is_ok(),
            });
        }
        // 2. partial repay of a multi-loop position (American: any time before expiry)
        {
            let (mut m, mut l) = market(&rules, 500, 4);
            let (looper, lender) = (1, 2);
            let mut lst = 100 * ONE;
            for i in 0..3 {
                let (_, new_lst, _) =
                    one_loop(&mut m, &rules, &mut l, looper, lender, lst, price, i, rate);
                lst = new_lst;
            }
            let r = m.pools[0].free_r(looper);
            let half = r / 2;
            let res = m.repay(0, &rules, &mut l, looper, half, 3 * DAY, 5000);
            let ok = res.is_ok()
                && m.pools[0].free_r(looper) == r - half
                && m.check_invariants(&l).is_ok();
            rows.push(EdgeRow {
                rules: rules.name(),
                case: "partial_repay_before_expiry",
                detail: format!("repaid {} of {} LST at day 3", eth(half), eth(r)),
                looper_pnl_native: 0.0,
                lender_pnl_native: 0.0,
                ok,
            });
        }
        // 3. running out of quote mid-unwind: repay fails cleanly, nothing moves
        {
            let (mut m, mut l) = market(&rules, 500, 4);
            let (looper, lender) = (1, 2);
            let mut lst = 100 * ONE;
            for i in 0..2 {
                let (_, new_lst, _) =
                    one_loop(&mut m, &rules, &mut l, looper, lender, lst, price, i, rate);
                lst = new_lst;
            }
            let r = m.pools[0].free_r(looper);
            l.quote.insert(looper, 1); // broke
            let before = m.pools[0].asset_bal;
            let res = m.repay(0, &rules, &mut l, looper, r, 3 * DAY, 5000);
            let ok =
                res.is_err() && m.pools[0].asset_bal == before && m.check_invariants(&l).is_ok();
            rows.push(EdgeRow {
                rules: rules.name(),
                case: "no_quote_to_unwind",
                detail: format!(
                    "repay of {} LST rejected: {}",
                    eth(r),
                    res.err().unwrap_or_default()
                ),
                looper_pnl_native: 0.0,
                lender_pnl_native: 0.0,
                ok,
            });
        }
        // 4. rollover of a looped position into the next expiry (fills in the window; v0.8 also last batch)
        {
            let (mut m, mut l) = market(&rules, 500, 4);
            let (looper, lender) = (1, 2);
            let mut lst = 100 * ONE;
            for i in 0..2 {
                let (_, new_lst, _) =
                    one_loop(&mut m, &rules, &mut l, looper, lender, lst, price, i, rate);
                lst = new_lst;
            }
            let next = m.create_pool(14 * DAY, K, 150, 0, 0);
            let r = m.pools[0].free_r(looper);
            let top_up = confluere_model::math::quote_up(r, K - price, ONE) + 20;
            let id = m
                .rollover(0, next, &mut l, looper, r, price, top_up, 8, 6 * DAY, 9000)
                .unwrap();
            // lender for the new pool
            m.pools[next]
                .place(&rules, &mut l, lender, Side::Buy, r, price, 0, 8)
                .unwrap();
            // last batch before expiry
            let ts_last = 7 * DAY - BATCH;
            let rep_last = m.settle(next, &rules, &mut l, ts_last, 9500).unwrap();
            let filled_before_expiry = rep_last.traded;
            // window batch
            m.mature(0, 7 * DAY, 10_000).unwrap();
            let rep_win = m
                .settle(next, &rules, &mut l, 7 * DAY + BATCH, 10_100)
                .unwrap();
            let moved = m.pools[next].r_of(looper) == r && m.pools[0].r_of(looper) == 0;
            let _ = id;
            rows.push(EdgeRow {
                rules: rules.name(),
                case: "rollover_looped_position",
                detail: format!("filled in last pre-expiry batch: {filled_before_expiry}; filled in window batch: {}; R moved to next pool: {moved}", rep_win.traded),
                looper_pnl_native: 0.0,
                lender_pnl_native: 0.0,
                ok: moved && m.check_invariants(&l).is_ok(),
            });
        }
    }
    write_csv("loop_edges.csv", &rows);
}
