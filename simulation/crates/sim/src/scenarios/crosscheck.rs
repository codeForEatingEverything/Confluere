//! Model (v0.7 rules) vs the compiled contracts in revm on random order books. Any mismatch in clearing
//! price, filled units or per-owner payouts fails the run; the CSV records every batch for the notebook.

use crate::common::*;
use alloy_primitives::U256;
use confluere_evm::{addr, GridConfig, Harness, BUY, NC_BUY, NC_SELL, SELL};
use confluere_model::{Rules, Side};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    seed: u64,
    batch: u32,
    orders: usize,
    model_price: f64,
    evm_price: f64,
    model_comp_units: f64,
    model_nc_units: f64,
    evm_settle_gas: u64,
    payouts_match: bool,
    price_match: bool,
}

pub fn run(n: u64) {
    let rules = Rules::v07();
    let k = 3400 * USDC;
    let expiry = 7 * DAY;
    let mut rows = Vec::new();
    let mut mismatches = 0;
    for seed in 0..n {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let gc = GridConfig {
            anchor: 0,
            period: 7 * DAY,
            batchInterval: BATCH,
            maxExpiries: 4,
            strikeSigDigits: 2,
        };
        let mut h = Harness::new(gc, 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
        let (mut m, mut l) = fresh(&rules, k, expiry, 800, 12);
        let n_acc = 12u32;
        for a in 1..=n_acc {
            h.mint(h.asset, addr(a as u64), U256::from(100_000 * ETH))
                .unwrap();
            h.mint(h.quote, addr(a as u64), U256::from(100_000_000 * USDC))
                .unwrap();
        }
        let pool = h.create_pool(addr(1), expiry, k, true, 1000, 800).unwrap();
        // the probe moves one base unit each way; mirror it so wallet balances compare
        for b in 0..3u32 {
            let n_orders = rng.random_range(2..=10);
            let mut placed = 0;
            for _ in 0..n_orders {
                let owner = rng.random_range(1..=n_acc);
                let side = match rng.random_range(0..10) {
                    0..=3 => Side::Sell,
                    4..=7 => Side::Buy,
                    8 => Side::NcSell,
                    _ => Side::NcBuy,
                };
                let units = rand_range(&mut rng, 1, 20) * ETH / 2;
                let limit = rand_range(&mut rng, 3200, 3399) * USDC;
                let budget = rand_range(&mut rng, 1000, 60_000) * USDC;
                let ttl = rng.random_range(1..=3u32);
                let (s8, u, lim, bud) = match side {
                    Side::Sell => (SELL, units, limit, 0),
                    Side::Buy => (BUY, units, limit, 0),
                    Side::NcSell => (NC_SELL, units, 0, 0),
                    Side::NcBuy => (NC_BUY, 0, 0, budget),
                };
                if std::env::var("SIM_DEBUG").is_ok() {
                    eprintln!(
                        "  place owner {owner} {side:?} units {} limit {} budget {} ttl {ttl}",
                        eth(u),
                        usdc(lim),
                        usdc(bud)
                    );
                }
                m.pools[0]
                    .place(&rules, &mut l, owner, side, u, lim, bud, ttl)
                    .unwrap();
                h.place(addr(owner as u64), pool, s8, u, lim, bud, ttl as u16)
                    .unwrap();
                placed += 1;
            }
            let ts = (b as u64 + 1) * BATCH;
            h.warp(ts, 10 + b as u64);
            let gas = h.settle(pool).unwrap();
            let rep = m.pools[0]
                .settle(&rules, &mut l, ts, 10 + b as u64)
                .unwrap();
            if std::env::var("SIM_DEBUG").is_ok() {
                eprintln!(
                    "  batch {b}: model {:?} evm price {} settleCount {}",
                    rep,
                    h.pool_view(pool).unwrap().lastClearingPrice,
                    h.pool_view(pool).unwrap().settleCount
                );
            }
            m.check_invariants(&l).unwrap();
            let v = h.pool_view(pool).unwrap();
            let evm_price: u128 = U256::from(v.lastClearingPrice).to();
            let price_match = evm_price == m.pools[0].last_clearing_price;
            let mut payouts_match = true;
            for a in 1..=n_acc {
                let r_m = m.pools[0].r_of(a);
                let c_m = m.pools[0].c_of(a);
                let r_e: u128 = h.position(addr(a as u64), pool, true).unwrap().to();
                let c_e: u128 = h.position(addr(a as u64), pool, false).unwrap().to();
                let pq_e: u128 = h.pending(h.quote, addr(a as u64)).unwrap().to();
                let pa_e: u128 = h.pending(h.asset, addr(a as u64)).unwrap().to();
                if r_m != r_e
                    || c_m != c_e
                    || l.pending_quote_of(a) != pq_e
                    || l.pending_asset_of(a) != pa_e
                {
                    payouts_match = false;
                }
            }
            if !price_match || !payouts_match {
                mismatches += 1;
                eprintln!("seed {seed} batch {b}: price model {} evm {evm_price}, payouts_match {payouts_match}", m.pools[0].last_clearing_price);
            }
            rows.push(Row {
                seed,
                batch: b,
                orders: placed,
                model_price: usdc(rep.price),
                evm_price: usdc(evm_price),
                model_comp_units: eth(rep.competitive_units),
                model_nc_units: eth(rep.nc_units),
                evm_settle_gas: gas,
                payouts_match,
                price_match,
            });
        }
    }
    write_csv("crosscheck.csv", &rows);
    println!(
        "crosscheck: {} batches, {} mismatches",
        rows.len(),
        mismatches
    );
    assert_eq!(mismatches, 0, "model diverges from the contracts");
}
