use confluere_model::{Grid, Ledger, Market, Rules};
use rand::Rng;
use rand_chacha::ChaCha8Rng;
use serde::Serialize;
use std::path::PathBuf;

pub const USDC: u128 = 1_000_000;
pub const ETH: u128 = 1_000_000_000_000_000_000;
pub const DAY: u64 = 86_400;
pub const BATCH: u64 = 1800;
pub const WINDOW_BLOCKS: u64 = 7200;
pub const MAX_PAUSE_BLOCKS: u64 = 50_400;

pub fn grid() -> Grid {
    Grid {
        anchor: 0,
        batch_interval: BATCH,
        window_blocks: WINDOW_BLOCKS,
        max_pause_blocks: MAX_PAUSE_BLOCKS,
    }
}

pub fn out_dir() -> PathBuf {
    let p = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../out"));
    std::fs::create_dir_all(&p).unwrap();
    p
}

pub fn write_csv<T: Serialize>(name: &str, rows: &[T]) {
    let path = out_dir().join(name);
    let mut w = csv::Writer::from_path(&path).unwrap();
    for r in rows {
        w.serialize(r).unwrap();
    }
    w.flush().unwrap();
    println!("wrote {} ({} rows)", path.display(), rows.len());
}

/// Annualised rate implied by buying at `price` and being repaid `k` after `days`.
pub fn apr(price: u128, k: u128, days: f64) -> f64 {
    if price == 0 {
        return f64::NAN;
    }
    (k as f64 / price as f64 - 1.0) * 365.0 / days
}

pub fn usdc(x: u128) -> f64 {
    x as f64 / USDC as f64
}
pub fn eth(x: u128) -> f64 {
    x as f64 / ETH as f64
}

pub fn fresh(
    rules: &Rules,
    k: u128,
    expiry: u64,
    band_bps: u128,
    accounts: u32,
) -> (Market, Ledger) {
    let mut m = Market::new(grid(), 18, true);
    m.create_pool(expiry, k, band_bps, 0, 0);
    let mut l = Ledger::default();
    for a in 1..=accounts {
        l.mint_quote(a, 100_000_000 * USDC);
        l.mint_asset(a, 100_000 * ETH);
    }
    let _ = rules;
    (m, l)
}

pub fn rand_range(rng: &mut ChaCha8Rng, lo: u128, hi: u128) -> u128 {
    rng.random_range(lo..=hi)
}
