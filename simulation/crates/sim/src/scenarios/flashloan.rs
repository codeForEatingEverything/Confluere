//! Section 1 "Flashloan": ERC-3156 against the real compiled core in revm. Borrow the full pool balance,
//! check the 0.05% fee lands in the treasury's pending balance, a non-repaying borrower reverts and leaves
//! every balance untouched, and nothing can be borrowed from an empty pool.

use crate::common::*;
use alloy_primitives::U256;
use confluere_evm::{addr, GridConfig, Harness, BUY, SELL};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    case: &'static str,
    amount_eth: f64,
    ok: bool,
    fee_eth: f64,
    treasury_pending_eth_after: f64,
    core_asset_after_eth: f64,
    gas: u64,
    error: String,
}

pub fn run() {
    let gc = GridConfig {
        anchor: 0,
        period: 7 * DAY,
        batchInterval: BATCH,
        maxExpiries: 4,
        strikeSigDigits: 2,
    };
    let mut h = Harness::new(gc, 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
    let (b, le) = (addr(1), addr(2));
    h.mint(h.asset, b, U256::from(1000 * ETH)).unwrap();
    h.mint(h.quote, le, U256::from(10_000_000 * USDC)).unwrap();
    h.mint(h.asset, addr(9), U256::from(ETH)).unwrap();
    h.mint(h.quote, addr(9), U256::from(USDC)).unwrap();
    let pool = h
        .create_pool(addr(9), 7 * DAY, 3400 * USDC, true, 1000, 800)
        .unwrap();
    let mut rows = Vec::new();
    // empty pool: the core holds only the escrowed sell (none yet) → nothing to lend
    let core_before: u128 = h.balance_of(h.asset, h.core).unwrap().to();
    let r = h.flash_loan(h.asset, ETH, true, ETH);
    rows.push(Row {
        case: "empty_core",
        amount_eth: 1.0,
        ok: r.is_ok(),
        fee_eth: 0.0,
        treasury_pending_eth_after: 0.0,
        core_asset_after_eth: eth(core_before),
        gas: 0,
        error: r.err().map(|e| e.to_string()).unwrap_or_default(),
    });
    // fund the pool: 100 ETH traded
    h.place(b, pool, SELL, 100 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    h.place(le, pool, BUY, 100 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    h.warp(BATCH, 10);
    h.settle(pool).unwrap();
    let core_bal: u128 = h.balance_of(h.asset, h.core).unwrap().to();
    // borrow everything the core holds (IMPLEMENTATION_NOTES: "flash loan may borrow the whole balance")
    for (case, amount, repay) in [
        ("full_balance_repaid", core_bal, true),
        ("over_balance", u128::MAX, true),
        ("full_balance_not_repaid", core_bal, false),
        ("half_repaid", core_bal / 2, true),
    ] {
        let before_tre: u128 = h.pending(h.asset, h.treasury).unwrap().to();
        // the treasury's fee from the previous loan stays in the core, so "over balance" is measured at call time
        let now_bal: u128 = h.balance_of(h.asset, h.core).unwrap().to();
        let amount = if amount == u128::MAX { now_bal + 1 } else { amount };
        let r = h.flash_loan(h.asset, amount, repay, amount / 1000 + 1);
        let after_tre: u128 = h.pending(h.asset, h.treasury).unwrap().to();
        let core_after: u128 = h.balance_of(h.asset, h.core).unwrap().to();
        rows.push(Row {
            case,
            amount_eth: eth(amount),
            ok: r.is_ok(),
            fee_eth: eth(after_tre - before_tre),
            treasury_pending_eth_after: eth(after_tre),
            core_asset_after_eth: eth(core_after),
            gas: r.as_ref().map(|g| *g).unwrap_or(0),
            error: r.err().map(|e| e.to_string()).unwrap_or_default(),
        });
    }
    // reentrancy: the borrower cannot settle or repay inside the callback (every entry is nonReentrant);
    // MockFlashBorrower does not try, so we document the guard from the source instead of a run.
    write_csv("flashloan.csv", &rows);
    let fees: u128 = h.flash_fees(h.asset).unwrap().to();
    println!("flashFees[asset] = {} ETH", eth(fees));
}
