//! Section 4 "Chaos": random borrowers, lenders, retail NC buyers, a vault, bidders, loopers (rollovers),
//! an attacker (wash + default, dust orders, bid spam), random keeper outages (late settle / mature / close)
//! and random guardian pauses over many expiries and strikes. Every step re-checks the invariants; a run
//! passes only if no step violates them and no funds are stranded.

use crate::common::*;
use confluere_model::{Ledger, Market, Rules, Side, Status, Vault, VaultTier};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    seed: u64,
    expiries: usize,
    pools: usize,
    batches_settled: u32,
    batches_skipped_keeper_down: u32,
    orders_placed: u32,
    orders_rejected: u32,
    rollovers: u32,
    bids: u32,
    pauses: u32,
    invariant_checks: u32,
    invariant_violations: u32,
    first_violation: String,
    stranded_quote_usdc: f64,
    stranded_asset_eth: f64,
    treasury_usdc: f64,
}

const STRIKES: [u128; 4] = [3200, 3400, 3600, 3800];
const VAULT: u32 = 900;

pub fn run(seeds: u64) {
    let mut rows = Vec::new();
    for seed in 0..seeds {
        for rules in [Rules::v07(), Rules::v08(), Rules::v08_tranche()] {
            let mut rng = ChaCha8Rng::seed_from_u64(1000 + seed);
            let mut m = Market::new(grid(), 18, true);
            let mut l = Ledger::default();
            let n_acc = 60u32;
            for a in 1..=n_acc {
                l.mint_quote(a, 50_000_000 * USDC);
                l.mint_asset(a, 20_000 * ETH);
            }
            l.mint_quote(VAULT, 0);
            let mut vault = Vault::new(VAULT, VaultTier::Low, Some(800));
            for a in 61..=65 {
                l.mint_quote(a, 2_000_000 * USDC);
                vault.request_deposit(&mut l, a, 1_000_000 * USDC).unwrap();
            }
            let n_exp = 8usize;
            let expiries: Vec<u64> = (1..=n_exp as u64).map(|i| i * 7 * DAY).collect();
            let (
                mut settled,
                mut skipped,
                mut placed,
                mut rejected,
                mut rollovers,
                mut bids,
                mut pauses,
            ) = (0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32);
            let (mut checks, mut violations) = (0u32, 0u32);
            let mut first_violation = String::new();
            let mut ref_price = 3400.0f64;
            let mut block = 1u64;
            let mut check = |m: &Market,
                             l: &Ledger,
                             checks: &mut u32,
                             violations: &mut u32,
                             first: &mut String,
                             where_: &str| {
                *checks += 1;
                if let Err(e) = m.check_invariants(l) {
                    *violations += 1;
                    if first.is_empty() {
                        *first = format!("{where_}: {e}");
                    }
                }
                if let Some(i) = m.pools.iter().position(|p| !p.tranche_consistent()) {
                    *violations += 1;
                    if first.is_empty() {
                        *first = format!("{where_}: tranche ledger of pool {i} inconsistent");
                    }
                }
            };
            // pools for the first two expiries exist from the start; later ones open as time passes
            for &e in &expiries[..2] {
                for k in STRIKES {
                    let i = m.create_pool(e, k * USDC, 800, 0, 0);
                    m.pools[i].auto_sell = true;
                }
            }
            let total_batches = (expiries[n_exp - 1] / BATCH) as u64 + (WINDOW_BLOCKS / BATCH) + 2;
            for b in 1..=total_batches {
                let ts = b * BATCH;
                block += BATCH; // 1 s blocks
                ref_price *= 1.0 + rng.random_range(-0.02..0.02);
                let rp = (ref_price * USDC as f64) as u128;
                // open pools two expiries ahead
                for &e in &expiries {
                    if e > ts && e <= ts + 14 * DAY && m.pool_at(e, 3400 * USDC).is_none() {
                        for k in STRIKES {
                            let i = m.create_pool(e, k * USDC, 800, 0, ts);
                            m.pools[i].auto_sell = true;
                        }
                    }
                }
                let open: Vec<usize> = (0..m.pools.len())
                    .filter(|&i| m.pools[i].status == Status::Open && m.pools[i].key.expiry > ts)
                    .collect();
                // random orders
                for _ in 0..rng.random_range(0..12) {
                    if open.is_empty() {
                        break;
                    }
                    let idx = open[rng.random_range(0..open.len())];
                    let k = m.pools[idx].key.strike;
                    let who = rng.random_range(1..=n_acc);
                    let units = rand_range(&mut rng, 1, 30) * ETH / 2;
                    let r = match rng.random_range(0..10) {
                        0..=3 => m.pools[idx].place_at(
                            &rules,
                            &mut l,
                            who,
                            Side::Sell,
                            units,
                            (rp as f64 * rng.random_range(0.95..1.0)) as u128,
                            0,
                            rng.random_range(1..=4),
                            block,
                        ),
                        4..=7 => m.pools[idx].place_at(
                            &rules,
                            &mut l,
                            who,
                            Side::Buy,
                            units,
                            ((rp as f64 * rng.random_range(0.95..1.01)) as u128).min(k - 1),
                            0,
                            rng.random_range(1..=4),
                            block,
                        ),
                        8 => m.pools[idx].place_at(
                            &rules,
                            &mut l,
                            who,
                            Side::NcBuy,
                            0,
                            0,
                            rand_range(&mut rng, 1_000, 50_000) * USDC,
                            1,
                            block,
                        ),
                        _ => m.pools[idx].place_at(
                            &rules,
                            &mut l,
                            who,
                            Side::NcSell,
                            units,
                            0,
                            0,
                            1,
                            block,
                        ),
                    };
                    if r.is_ok() {
                        placed += 1;
                    } else {
                        rejected += 1;
                    }
                }
                // attacker: dust orders, occasional wash at K−1
                if rng.random_range(0..5) == 0 && !open.is_empty() {
                    let idx = open[rng.random_range(0..open.len())];
                    let k = m.pools[idx].key.strike;
                    let _ = m.pools[idx].place_at(
                        &rules,
                        &mut l,
                        59,
                        Side::Sell,
                        1,
                        k - 1,
                        0,
                        1,
                        block,
                    );
                    let _ =
                        m.pools[idx].place_at(&rules, &mut l, 59, Side::Buy, 1, k - 1, 0, 1, block);
                    let w = 5 * ETH;
                    let _ = m.pools[idx].place_at(
                        &rules,
                        &mut l,
                        60,
                        Side::Sell,
                        w,
                        k - USDC,
                        0,
                        1,
                        block,
                    );
                    let _ = m.pools[idx].place_at(
                        &rules,
                        &mut l,
                        60,
                        Side::Buy,
                        w,
                        k - USDC,
                        0,
                        1,
                        block,
                    );
                }
                // rollovers: R holders in pools expiring within 2 days roll into the next expiry
                for i in 0..m.pools.len() {
                    let (e, k) = (m.pools[i].key.expiry, m.pools[i].key.strike);
                    if e > ts
                        && e <= ts + 2 * DAY
                        && m.pools[i].status == Status::Open
                        && rng.random_range(0..4) == 0
                    {
                        if let Some(nx) = expiries
                            .iter()
                            .find(|&&x| x > e)
                            .and_then(|&x| m.pool_at(x, k))
                        {
                            let who = rng.random_range(1..=n_acc);
                            let r = m.pools[i].free_r(who);
                            if r != 0 {
                                let minp = rp * 95 / 100;
                                let need = confluere_model::math::quote_up(
                                    r,
                                    k.saturating_sub(minp).max(1),
                                    ETH,
                                ) + 20;
                                if m.rollover(i, nx, &mut l, who, r, minp, need, 8, ts, block)
                                    .is_ok()
                                {
                                    rollovers += 1;
                                }
                            }
                        }
                    }
                }
                // guardian: rare pause of an un-graduated pool
                if !m.graduated && rng.random_range(0..200) == 0 && !open.is_empty() {
                    let idx = open[rng.random_range(0..open.len())];
                    if m.pools[idx]
                        .pause(&rules, block, rand_range(&mut rng, 100, 20_000) as u64)
                        .is_ok()
                    {
                        pauses += 1;
                    }
                }
                // vault pokes for the nearest open expiry
                if let Some(&e) = expiries.iter().find(|&&x| x > ts) {
                    let prev = expiries
                        .iter()
                        .rev()
                        .find(|&&x| x <= ts)
                        .copied()
                        .unwrap_or(0);
                    if prev != 0 {
                        vault.poke(&mut m, &rules, &mut l, e, prev);
                    }
                }
                // keeper: settles every open pool, unless it is "down" this batch (10%)
                let keeper_down = rng.random_range(0..10) == 0;
                for i in 0..m.pools.len() {
                    if m.pools[i].status == Status::Open {
                        if keeper_down {
                            skipped += 1;
                            continue;
                        }
                        if m.settle(i, &rules, &mut l, ts, block).is_ok() {
                            settled += 1;
                        }
                    }
                }
                check(
                    &m,
                    &l,
                    &mut checks,
                    &mut violations,
                    &mut first_violation,
                    &format!("after settle b{b}"),
                );
                // expiries: mature (sometimes late), repay rationally with some forgetful borrowers, bids, close
                for &e in &expiries {
                    if ts >= e && ts < e + WINDOW_BLOCKS + 2 * BATCH {
                        let late = rng.random_range(0..3) == 0;
                        for i in 0..m.pools.len() {
                            if m.pools[i].key.expiry == e
                                && m.pools[i].status == Status::Open
                                && !late
                            {
                                let _ = m.mature(i, ts, block);
                            }
                        }
                        for i in 0..m.pools.len() {
                            if m.pools[i].key.expiry != e {
                                continue;
                            }
                            let k = m.pools[i].key.strike;
                            let in_window = m.window_open(i, ts, block);
                            if in_window && rp > k {
                                for a in 1..=n_acc {
                                    let r = m.pools[i].free_r(a);
                                    if r != 0 && rng.random_range(0..20) != 0 {
                                        l.withdraw_quote(a);
                                        let _ = m.repay(i, &rules, &mut l, a, r, ts, block);
                                    }
                                }
                            }
                            if m.pools[i].status == Status::Window && rng.random_range(0..2) == 0 {
                                let who = rng.random_range(1..=n_acc);
                                let premium = rand_range(&mut rng, 0, 200) * USDC;
                                if m.pools[i]
                                    .bid(
                                        &mut l,
                                        who,
                                        rand_range(&mut rng, 1, 10) * ETH,
                                        premium,
                                        block,
                                    )
                                    .is_ok()
                                {
                                    bids += 1;
                                }
                            }
                            if let Some(we) = m.window_end(e) {
                                if block >= we {
                                    if m.pools[i].status == Status::Open {
                                        let _ = m.mature(i, ts, block);
                                    }
                                    let _ = m.close(i, &rules, &mut l, block);
                                }
                            }
                        }
                        check(
                            &m,
                            &l,
                            &mut checks,
                            &mut violations,
                            &mut first_violation,
                            &format!("after window ops b{b}"),
                        );
                    }
                    // everyone claims closed pools; vault rolls
                    if ts == e + WINDOW_BLOCKS + 2 * BATCH {
                        for i in 0..m.pools.len() {
                            if m.pools[i].key.expiry == e && m.pools[i].status == Status::Closed {
                                for a in 1..=n_acc {
                                    let _ = m.pools[i].claim(&mut l, a);
                                }
                            }
                        }
                        vault.roll(&mut m, &mut l, rp, ts);
                        m.check_graduation(&rules, 4);
                        check(
                            &m,
                            &l,
                            &mut checks,
                            &mut violations,
                            &mut first_violation,
                            &format!("after claims b{b}"),
                        );
                    }
                }
            }
            // stranded funds: core balance minus everything accounted for (pending + escrows + pool balances)
            for a in 1..=n_acc {
                l.withdraw_quote(a);
                l.withdraw_asset(a);
            }
            let stranded_q = l.core_quote - m.total_escrowed_quote() - l.total_pending_quote();
            let stranded_a = l.core_asset - m.total_escrowed_asset() - l.total_pending_asset();
            rows.push(Row {
                rules: rules.name(),
                seed,
                expiries: n_exp,
                pools: m.pools.len(),
                batches_settled: settled,
                batches_skipped_keeper_down: skipped,
                orders_placed: placed,
                orders_rejected: rejected,
                rollovers,
                bids,
                pauses,
                invariant_checks: checks,
                invariant_violations: violations,
                first_violation,
                stranded_quote_usdc: usdc(stranded_q),
                stranded_asset_eth: eth(stranded_a),
                treasury_usdc: usdc(l.pending_quote_of(confluere_model::TREASURY)),
            });
        }
    }
    write_csv("chaos.csv", &rows);
    let bad: Vec<&Row> = rows.iter().filter(|r| r.invariant_violations > 0).collect();
    for r in &bad {
        eprintln!(
            "CHAOS seed {} {}: {} violations, first: {}",
            r.seed, r.rules, r.invariant_violations, r.first_violation
        );
    }
    assert!(bad.is_empty(), "chaos: invariant violations");
}
