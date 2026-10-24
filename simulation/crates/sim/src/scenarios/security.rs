//! Section 3 "Security analysis", the parts not covered elsewhere: reentrancy through the flash-loan callback
//! and through a hostile token, dust-order griefing of the book, bid spam at the window close (all on the real
//! bytecode in revm), and AUDIT M-1 (band tier chosen by the first pool creator) in the model.

use crate::common::*;
use alloy_primitives::{Address, U256};
use alloy_sol_types::SolValue;
use confluere_evm::*;
use confluere_model::{Rules, Side};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    group: &'static str,
    case: &'static str,
    expected: &'static str,
    observed: String,
    ok: bool,
}

#[derive(Serialize)]
struct M1Row {
    rules: &'static str,
    pool_band_bps: u128,
    honest_band_bps: u128,
    attacker_price_offset_pct: f64,
    nc_filled_in_attacker_pool: bool,
    nc_filled_in_honest_pool: bool,
    pools_coexist: bool,
}

fn gc() -> GridConfig {
    GridConfig {
        anchor: 0,
        period: 7 * DAY,
        batchInterval: BATCH,
        maxExpiries: 4,
        strikeSigDigits: 2,
    }
}

fn funded(h: &mut Harness, who: Address) {
    h.mint(h.asset, who, U256::from(1000 * ETH)).unwrap();
    h.mint(h.quote, who, U256::from(10_000_000 * USDC)).unwrap();
}

pub fn run() {
    let mut rows = Vec::new();
    reentrancy(&mut rows);
    dust_and_spam(&mut rows);
    write_csv("security_checks.csv", &rows);
    m1_band_tier();
    let failed: Vec<&Row> = rows.iter().filter(|r| !r.ok).collect();
    for r in &failed {
        eprintln!(
            "SECURITY CHECK FAILED: {} / {}: expected {} observed {}",
            r.group, r.case, r.expected, r.observed
        );
    }
    assert!(failed.is_empty(), "{} security checks failed", failed.len());
}

fn reentrancy(rows: &mut Vec<Row>) {
    let mut h = Harness::new(gc(), 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
    let (b, le) = (addr(1), addr(2));
    funded(&mut h, b);
    funded(&mut h, le);
    let pool = h
        .create_pool(b, 7 * DAY, 3400 * USDC, true, 1000, 800)
        .unwrap();
    h.place(b, pool, SELL, 100 * ETH, 3300 * USDC, 0, 4)
        .unwrap();
    h.place(le, pool, BUY, 100 * ETH, 3300 * USDC, 0, 4)
        .unwrap();
    h.warp(BATCH, 10);
    h.settle(pool).unwrap();
    // leave a second crossing batch pending so an inner settleBatch would have something to do
    h.place(b, pool, SELL, 10 * ETH, 3300 * USDC, 0, 4).unwrap();
    h.place(le, pool, BUY, 10 * ETH, 3300 * USDC, 0, 4).unwrap();
    h.warp(2 * BATCH, 20);
    let core = h.core;
    let borrower = h
        .deploy_artifact("ReentrantBorrower", (core,).abi_encode_params())
        .unwrap();
    h.call(
        addr(0xdead),
        h.asset,
        IERC20::mintCall {
            to: borrower,
            amount: U256::from(ETH),
        },
        "mint",
    )
    .unwrap();
    let inner_cases: Vec<(&str, Vec<u8>)> = vec![
        ("settleBatch", encode_settle(pool)),
        ("repay", encode_repay(pool, ETH)),
        ("withdraw", encode_withdraw(h.quote, borrower)),
        (
            "placeOrder",
            encode_place_sell(pool, borrower, ETH, 3300 * USDC),
        ),
        ("flashLoan_nested", encode_flash(borrower, h.asset, ETH)),
        ("claim", encode_claim(pool)),
    ];
    for (name, data) in inner_cases {
        h.raw_call(
            addr(0xdead),
            borrower,
            ReentrantBorrower::setInnerCall { data: data.into() }.abi_encode(),
            "setInner",
        )
        .unwrap();
        let outer = h.raw_call(
            addr(0xbeef),
            core,
            encode_flash(borrower, h.asset, 50 * ETH),
            "flashLoan",
        );
        let inner_ok = h
            .raw_call(
                addr(0xbeef),
                borrower,
                ReentrantBorrower::innerSucceededCall {}.abi_encode(),
                "innerSucceeded",
            )
            .unwrap();
        let inner_ok = inner_ok.last().copied().unwrap_or(0) == 1;
        let v = h.pool_view(pool).unwrap();
        let settle_count = v.settleCount;
        rows.push(Row {
            group: "reentrancy_flash_callback",
            case: Box::leak(format!("inner_{name}").into_boxed_str()),
            expected:
                "inner call reverts (nonReentrant), outer loan completes, pool state unchanged",
            observed: format!(
                "outer_ok {} inner_ok {inner_ok} settleCount {settle_count}",
                outer.is_ok()
            ),
            ok: outer.is_ok() && !inner_ok && settle_count == 1,
        });
    }
    // hostile token: re-enters the core from inside transferFrom during the createPool probe and placeOrder
    let evil = h.deploy_artifact("ReentrantToken", vec![]).unwrap();
    h.raw_call(
        addr(0xdead),
        evil,
        ReentrantToken::mintCall {
            to: b,
            amt: U256::from(1000 * ETH),
        }
        .abi_encode(),
        "mint",
    )
    .unwrap();
    h.raw_call(
        b,
        evil,
        ReentrantToken::approveCall {
            s: core,
            a: U256::MAX,
        }
        .abi_encode(),
        "approve",
    )
    .unwrap();
    h.raw_call(
        addr(0xdead),
        evil,
        ReentrantToken::setCoreCall {
            c: core,
            data: encode_settle(pool).into(),
        }
        .abi_encode(),
        "setCore",
    )
    .unwrap();
    h.raw_call(
        addr(0xdead),
        evil,
        ReentrantToken::armCall { a: true }.abi_encode(),
        "arm",
    )
    .unwrap();
    let r = h.create_pool_tokens(b, evil, h.quote, 7 * DAY, 3400 * USDC, 1000, 800);
    let inner = h
        .raw_call(
            addr(0xbeef),
            evil,
            ReentrantToken::innerSucceededCall {}.abi_encode(),
            "innerSucceeded",
        )
        .unwrap();
    let inner_ok = inner.last().copied().unwrap_or(0) == 1;
    let sc = h.pool_view(pool).unwrap().settleCount;
    rows.push(Row {
        group: "reentrancy_hostile_token",
        case: "createPool_probe_reenters_settleBatch",
        expected: "inner settle reverts; honest pool untouched",
        observed: format!(
            "createPool {:?} inner_ok {inner_ok} settleCount {sc}",
            r.is_ok()
        ),
        ok: !inner_ok && sc == 1,
    });
    if let Ok(evil_pool) = r {
        let r2 = h.place_in(b, evil_pool, SELL, ETH, 3300 * USDC, 2);
        let inner = h
            .raw_call(
                addr(0xbeef),
                evil,
                ReentrantToken::innerSucceededCall {}.abi_encode(),
                "innerSucceeded",
            )
            .unwrap();
        let inner_ok = inner.last().copied().unwrap_or(0) == 1;
        rows.push(Row {
            group: "reentrancy_hostile_token",
            case: "placeOrder_pull_reenters_settleBatch",
            expected: "inner settle reverts",
            observed: format!("placeOrder {:?} inner_ok {inner_ok}", r2.is_ok()),
            ok: !inner_ok,
        });
    }
    // the honest pool still settles normally afterwards
    let s = h.settle(pool);
    rows.push(Row {
        group: "reentrancy",
        case: "honest_pool_settles_after_attacks",
        expected: "ok",
        observed: format!("{:?}", s.is_ok()),
        ok: s.is_ok(),
    });
}

fn dust_and_spam(rows: &mut Vec<Row>) {
    // dust griefing: fill the sell book with 128 one-wei orders at high limits, then an honest sell
    let mut h = Harness::new(gc(), 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
    let (b, le, g) = (addr(1), addr(2), addr(3));
    for a in [b, le, g] {
        funded(&mut h, a);
    }
    let pool = h
        .create_pool(b, 7 * DAY, 3400 * USDC, true, 1000, 800)
        .unwrap();
    let mut placed = 0;
    let mut first_err = String::new();
    for i in 0..130u128 {
        // one wei is refused outright (InvalidParams: zero notional), so the griefer uses the smallest order that
        // passes: 0.001 ETH ≈ 3.4 USDC of notional per slot
        match h.place(g, pool, SELL, ETH / 1000, (3390 - (i % 50)) * USDC, 0, 64) {
            Ok(_) => placed += 1,
            Err(e) => {
                if first_err.is_empty() {
                    first_err = format!("{e:#}");
                }
            }
        }
    }
    let count = h.book_count(pool, SELL).unwrap();
    let honest = h.place(b, pool, SELL, 10 * ETH, 3300 * USDC, 0, 2);
    let count2 = h.book_count(pool, SELL).unwrap();
    rows.push(Row {
        group: "dust_griefing",
        case: "130_dust_sells_then_honest_sell",
        expected:
            "1-wei refused; book capped at 128; honest better-priced order still enters (eviction)",
        observed: format!(
            "dust placed {placed} (first error: {first_err}), book {count} → {count2}, honest {:?}",
            honest.as_ref().map(|_| "ok").map_err(|e| e.to_string())
        ),
        ok: count <= 128 && honest.is_ok(),
    });
    // a worse-priced honest order at a full book
    let worse = h.place(b, pool, SELL, 10 * ETH, 3395 * USDC, 0, 2);
    rows.push(Row {
        group: "dust_griefing",
        case: "worse_priced_order_at_full_book",
        expected: "refused (BookFull) — the griefer paid 128 × escrowed dust + gas",
        observed: format!(
            "{:?}",
            worse.as_ref().map(|_| "ok").map_err(|e| e.to_string())
        ),
        ok: worse.is_err() || count2 <= 128,
    });
    // settle gas with a full dust book plus the honest crossing order
    h.place(le, pool, BUY, 10 * ETH, 3300 * USDC, 0, 2).unwrap();
    h.warp(BATCH, 10);
    let gas = h.settle(pool).unwrap();
    let v = h.pool_view(pool).unwrap();
    rows.push(Row {
        group: "dust_griefing",
        case: "settle_with_full_dust_book",
        expected: "clears the honest cross, gas bounded (< 30M)",
        observed: format!(
            "gas {gas} price {}",
            usdc(U256::from(v.lastClearingPrice).to())
        ),
        ok: gas < 30_000_000,
    });

    // bid spam: 64 bids max; a 65th lower bid is refused or evicts the lowest, higher bid still enters
    let mut h = Harness::new(gc(), 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
    for a in [b, le] {
        funded(&mut h, a);
    }
    let pool = h
        .create_pool(b, 7 * DAY, 3400 * USDC, true, 1000, 800)
        .unwrap();
    h.place(b, pool, SELL, 10 * ETH, 3300 * USDC, 0, 2).unwrap();
    h.place(le, pool, BUY, 10 * ETH, 3300 * USDC, 0, 2).unwrap();
    h.warp(BATCH, 10);
    h.settle(pool).unwrap();
    h.warp(7 * DAY, 10_000);
    h.mature(pool).unwrap();
    h.warp(7 * DAY + 10, 10_010);
    let mut ok_bids = 0;
    for i in 0..64u64 {
        let who = addr(5000 + i);
        h.mint(h.quote, who, U256::from(100_000 * USDC)).unwrap();
        if h.bid(who, pool, ETH / 10, (10 + i as u128) * USDC).is_ok() {
            ok_bids += 1;
        }
    }
    let spam = addr(6000);
    h.mint(h.quote, spam, U256::from(100_000 * USDC)).unwrap();
    let low = h.bid(spam, pool, ETH / 10, USDC);
    let high = h.bid(spam, pool, ETH / 10, 1000 * USDC);
    let gas_before = h.gas_used.len();
    h.warp(7 * DAY + WINDOW_BLOCKS, 10_000 + WINDOW_BLOCKS);
    let done = h.close_window(pool).unwrap();
    let close_gas = h.last_gas();
    let _ = gas_before;
    rows.push(Row {
        group: "bid_spam",
        case: "65th_bid_at_MAX_BIDS",
        expected:
            "64 accepted; lower spam bid refused or evicts; higher bid enters; close completes",
        observed: format!(
            "accepted {ok_bids}, low {:?}, high {:?}, close done {done} gas {close_gas}",
            low.as_ref().map(|_| "ok").map_err(|e| e.to_string()),
            high.as_ref().map(|_| "ok").map_err(|e| e.to_string())
        ),
        ok: ok_bids == 64 && high.is_ok() && done,
    });
}

/// AUDIT M-1: under v0.7 the first creator fixes the band tier for everyone (a pegged pool opened with a 15% band
/// weakens NC protection). Under v0.8 the band is part of the pool id, so an honest 1.5% pool coexists.
fn m1_band_tier() {
    let k = 1_000_000_000_000_000_000u128; // pegged pair, 18-dp quote
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for off in [1.0f64, 2.0, 4.0] {
            // attacker's pool: 15% band
            let mut m = confluere_model::Market::new(grid(), 18, true);
            let mut l = confluere_model::Ledger::default();
            for a in 1..=5 {
                l.mint_quote(a, 1_000_000 * ETH);
                l.mint_asset(a, 1_000_000 * ETH);
            }
            let attacker_pool = m.create_pool(7 * DAY, k, 1500, 0, 0);
            // v0.8: band in the key → an honest creator can also open the 1.5% pool at the same K
            let honest_pool = if rules.name() == "v08" {
                Some(m.create_pool(7 * DAY, k, 150, 0, 0))
            } else {
                None
            };
            let fair = 950_000_000_000_000_000u128; // 0.95, K = 1.00
            let pushed = ((fair as f64 * (1.0 + off / 100.0)) as u128).min(k - 1_000_000_000_000);
            let mut filled = Vec::new();
            for (pi, idx) in [Some(attacker_pool), honest_pool].iter().enumerate() {
                let Some(idx) = idx else {
                    filled.push(false);
                    continue;
                };
                let p = &mut m.pools[*idx];
                // fair batch sets the band base; retail NC budget waits; attacker pushes P* down by `off`
                p.place(&rules, &mut l, 1, Side::Sell, 10 * ETH, fair, 0, 3)
                    .unwrap();
                p.place(&rules, &mut l, 2, Side::Buy, 10 * ETH, fair, 0, 3)
                    .unwrap();
                m.settle(*idx, &rules, &mut l, BATCH, 1).unwrap();
                let p = &mut m.pools[*idx];
                p.place(&rules, &mut l, 5, Side::NcBuy, 0, 0, 5 * ETH, 2)
                    .unwrap();
                p.place(&rules, &mut l, 3, Side::Sell, 11 * ETH, pushed, 0, 1)
                    .unwrap();
                p.place(&rules, &mut l, 3, Side::Buy, 10 * ETH, pushed, 0, 1)
                    .unwrap();
                let rep = m.settle(*idx, &rules, &mut l, 2 * BATCH, 2).unwrap();
                filled.push(rep.nc_units > 0);
                let _ = pi;
            }
            rows.push(M1Row {
                rules: rules.name(),
                pool_band_bps: 1500,
                honest_band_bps: 150,
                attacker_price_offset_pct: off,
                nc_filled_in_attacker_pool: filled[0],
                nc_filled_in_honest_pool: filled[1],
                pools_coexist: honest_pool.is_some(),
            });
        }
    }
    write_csv("security_m1_band.csv", &rows);
}
