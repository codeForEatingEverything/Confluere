//! Section 3 "Maintainability": gas of settleBatch vs book depth (up to MAX_ORDERS_PER_SIDE = 128) and of
//! closeWindow vs number of bids (up to MAX_BIDS = 64), on the real bytecode in revm. Keeper cost per day
//! is derived from the batch cadence of each chain.

use crate::common::*;
use alloy_primitives::U256;
use confluere_evm::{addr, GridConfig, Harness, BUY, SELL};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    op: &'static str,
    n: u32,
    gas: u64,
    place_gas_avg: f64,
}

#[derive(Serialize)]
struct KeeperRow {
    chain: &'static str,
    batch_seconds: u64,
    settles_per_day_per_pool: f64,
    gas_per_settle_typical: u64,
    gas_per_day_per_pool_m: f64,
}

pub fn run() {
    let mut rows = Vec::new();
    for n in [1u32, 2, 4, 8, 16, 32, 64, 128] {
        let gc = GridConfig {
            anchor: 0,
            period: 7 * DAY,
            batchInterval: BATCH,
            maxExpiries: 4,
            strikeSigDigits: 2,
        };
        let mut h = Harness::new(gc, 100, 1, WINDOW_BLOCKS, 18, 6).unwrap();
        let mut place_gas = Vec::new();
        for i in 0..n {
            let s = addr(1000 + i as u64);
            let b = addr(2000 + i as u64);
            h.mint(h.asset, s, U256::from(100 * ETH)).unwrap();
            h.mint(h.quote, b, U256::from(1_000_000 * USDC)).unwrap();
        }
        h.mint(h.asset, addr(9), U256::from(ETH)).unwrap();
        h.mint(h.quote, addr(9), U256::from(USDC)).unwrap();
        let pool = h
            .create_pool(addr(9), 7 * DAY, 3400 * USDC, true, 1000, 800)
            .unwrap();
        for i in 0..n {
            // all cross: sells 3200..3300 ascending, buys 3300..3399 descending
            h.place(
                addr(1000 + i as u64),
                pool,
                SELL,
                ETH,
                (3200 + (i as u128 * 100) / n as u128) * USDC,
                0,
                2,
            )
            .unwrap();
            place_gas.push(h.last_gas());
            h.place(
                addr(2000 + i as u64),
                pool,
                BUY,
                ETH,
                (3399 - (i as u128 * 99) / n as u128) * USDC,
                0,
                2,
            )
            .unwrap();
            place_gas.push(h.last_gas());
        }
        h.warp(BATCH, 10);
        let gas = h.settle(pool).unwrap();
        rows.push(Row {
            op: "settleBatch",
            n: n * 2,
            gas,
            place_gas_avg: place_gas.iter().sum::<u64>() as f64 / place_gas.len() as f64,
        });
    }
    for n in [0u32, 1, 8, 32, 64] {
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
        h.mint(h.quote, b, U256::from(USDC)).unwrap();
        h.mint(h.quote, le, U256::from(10_000_000 * USDC)).unwrap();
        let pool = h
            .create_pool(b, 7 * DAY, 3400 * USDC, true, 1000, 800)
            .unwrap();
        h.place(b, pool, SELL, 100 * ETH, 3300 * USDC, 0, 2)
            .unwrap();
        h.place(le, pool, BUY, 100 * ETH, 3300 * USDC, 0, 2)
            .unwrap();
        h.warp(BATCH, 10);
        h.settle(pool).unwrap();
        h.warp(7 * DAY, 10_000);
        h.mature(pool).unwrap();
        h.warp(7 * DAY + 10, 10_010);
        let mut bid_gas = Vec::new();
        for i in 0..n {
            let who = addr(3000 + i as u64);
            h.mint(h.quote, who, U256::from(1_000_000 * USDC)).unwrap();
            h.bid(who, pool, ETH, (i as u128 + 1) * USDC).unwrap();
            bid_gas.push(h.last_gas());
        }
        h.warp(7 * DAY + WINDOW_BLOCKS, 10_000 + WINDOW_BLOCKS);
        let done = h.close_window(pool).unwrap();
        let gas = h.last_gas();
        assert!(done);
        rows.push(Row {
            op: "closeWindow",
            n,
            gas,
            place_gas_avg: if bid_gas.is_empty() {
                0.0
            } else {
                bid_gas.iter().sum::<u64>() as f64 / bid_gas.len() as f64
            },
        });
    }
    write_csv("gas.csv", &rows);
    let typical = rows
        .iter()
        .find(|r| r.op == "settleBatch" && r.n == 16)
        .map(|r| r.gas)
        .unwrap_or(0);
    let keeper: Vec<KeeperRow> = [
        ("Monad", 1800u64),
        ("HyperEVM", 1800),
        ("Sepolia", 1800),
        ("long-tail 6h", 21_600),
        ("long-tail 24h", 86_400),
    ]
    .iter()
    .map(|(c, s)| KeeperRow {
        chain: c,
        batch_seconds: *s,
        settles_per_day_per_pool: 86_400.0 / *s as f64,
        gas_per_settle_typical: typical,
        gas_per_day_per_pool_m: 86_400.0 / *s as f64 * typical as f64 / 1e6,
    })
    .collect();
    write_csv("keeper_cost.csv", &keeper);
}
