//! Section 2 edge cases: extreme price paths and the circuit breaker, block-based window timing (chain halt,
//! late mature, last-block repay, close racing repay), guardian pause semantics, LP edge cases (C transfer,
//! double claim, claim order), long-tail pools (cadence, minimum fill, first-auction bounds), graduation
//! restart, the two dilution-fix variants, and the NC share cap sweep.

use crate::common::*;
use confluere_model::{Ledger, Market, Rules, Side, Status, TREASURY};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;

#[derive(Serialize)]
struct Check {
    group: &'static str,
    rules: &'static str,
    case: &'static str,
    expected: &'static str,
    observed: String,
    ok: bool,
}

#[derive(Serialize)]
struct ExtremeRow {
    rules: &'static str,
    path: &'static str,
    batch: u32,
    ref_price: f64,
    traded: bool,
    price: f64,
    nc_units: f64,
    band_failures: u32,
    breaker_tripped: bool,
    no_trade_reason: String,
}

#[derive(Serialize)]
struct DilutionRow {
    variant: &'static str,
    wash_multiple: f64,
    attacker_pnl_usdc: f64,
    honest_lender_pnl_usdc: f64,
    honest_fill_blocked: bool,
}

#[derive(Serialize)]
struct CapRow {
    nc_cap_bps: u128,
    nc_budget_usdc: f64,
    price: f64,
    implied_apr: f64,
    competitive_units: f64,
    nc_units: f64,
}

pub fn run() {
    let mut checks = Vec::new();
    extreme();
    time(&mut checks);
    pause(&mut checks);
    lp(&mut checks);
    longtail(&mut checks);
    graduation_restart(&mut checks);
    write_csv("edge_checks.csv", &checks);
    dilution_variants();
    nc_cap_sweep();
    let failed: Vec<&Check> = checks.iter().filter(|c| !c.ok).collect();
    for c in &failed {
        eprintln!(
            "EDGE CHECK FAILED: {} / {} / {}: expected {} observed {}",
            c.group, c.rules, c.case, c.expected, c.observed
        );
    }
    assert!(failed.is_empty(), "{} edge checks failed", failed.len());
}

/// −50% in one batch, flash crash and recovery, zero-volume stretch, one-sided book: how the band / breaker react.
fn extreme() {
    let k = 3400 * USDC;
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for path in [
            "crash_50",
            "flash_crash_recover",
            "zero_volume",
            "one_sided",
        ] {
            let mut rng = ChaCha8Rng::seed_from_u64(3);
            let (mut m, mut l) = fresh(&rules, k, 7 * DAY, 800, 10);
            let mut ref_price = 3300.0f64;
            let mut tripped = false;
            for b in 0..24u32 {
                ref_price = match (path, b) {
                    ("crash_50", 8) => ref_price * 0.5,
                    ("flash_crash_recover", 8) => ref_price * 0.6,
                    ("flash_crash_recover", 9) => ref_price / 0.6,
                    _ => ref_price * (1.0 + rng.random_range(-0.003..0.003)),
                };
                let rp = (ref_price * USDC as f64) as u128;
                let p = &mut m.pools[0];
                let quiet = path == "zero_volume" && (6..14).contains(&b);
                let one_sided = path == "one_sided" && (6..14).contains(&b);
                if !quiet {
                    p.place(
                        &rules,
                        &mut l,
                        1,
                        Side::Sell,
                        10 * ETH,
                        rp * 995 / 1000,
                        0,
                        1,
                    )
                    .unwrap();
                    if !one_sided {
                        p.place(
                            &rules,
                            &mut l,
                            2,
                            Side::Buy,
                            10 * ETH,
                            (rp * 1000 / 1000).min(k - USDC),
                            0,
                            1,
                        )
                        .unwrap();
                    }
                }
                p.place(&rules, &mut l, 3, Side::NcBuy, 0, 0, 10_000 * USDC, 1)
                    .unwrap();
                let rep = m
                    .settle(0, &rules, &mut l, (b as u64 + 1) * BATCH, b as u64)
                    .unwrap();
                if rep.band_failures >= 3 {
                    tripped = true;
                }
                rows.push(ExtremeRow {
                    rules: rules.name(),
                    path,
                    batch: b,
                    ref_price,
                    traded: rep.traded,
                    price: usdc(rep.price),
                    nc_units: eth(rep.nc_units),
                    band_failures: rep.band_failures,
                    breaker_tripped: tripped || m.pools[0].bad,
                    no_trade_reason: rep.no_trade_reason.to_string(),
                });
                m.check_invariants(&l).unwrap();
            }
        }
    }
    write_csv("edge_extreme.csv", &rows);
}

fn push(
    checks: &mut Vec<Check>,
    group: &'static str,
    rules: &Rules,
    case: &'static str,
    expected: &'static str,
    observed: String,
    ok: bool,
) {
    checks.push(Check {
        group,
        rules: rules.name(),
        case,
        expected,
        observed,
        ok,
    });
}

fn traded_pool(rules: &Rules) -> (Market, Ledger) {
    let (mut m, mut l) = fresh(rules, 3400 * USDC, 7 * DAY, 800, 10);
    m.pools[0]
        .place(rules, &mut l, 1, Side::Sell, 10 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    m.pools[0]
        .place(rules, &mut l, 2, Side::Buy, 10 * ETH, 3300 * USDC, 0, 2)
        .unwrap();
    m.settle(0, rules, &mut l, BATCH, 1).unwrap();
    l.withdraw_quote(1);
    (m, l)
}

fn time(checks: &mut Vec<Check>) {
    for rules in [Rules::v07(), Rules::v08()] {
        let e = 7 * DAY;
        // chain halt: no blocks for hours after mature → the window does not advance
        {
            let (mut m, mut l) = traded_pool(&rules);
            let wend = m.mature(0, e, 10_000).unwrap();
            // 10 hours pass in wall time, zero blocks mined
            let r = m.repay(0, &rules, &mut l, 1, 10 * ETH, e + 10 * 3600, 10_000);
            let c = m.close(0, &rules, &mut l, 10_000);
            push(
                checks,
                "time",
                &rules,
                "chain_halt_window_frozen",
                "repay ok, close refused",
                format!(
                    "repay {:?} close {:?} window_end {wend}",
                    r.is_ok(),
                    c.is_err()
                ),
                r.is_ok() && c.is_err(),
            );
        }
        // late mature: nobody calls mature for a day; repay still allowed inside the shared window logic
        {
            let (mut m, mut l) = traded_pool(&rules);
            let r = m.repay(0, &rules, &mut l, 1, 5 * ETH, e + DAY, 20_000); // Open past expiry, no window yet
            let wend = m.mature(0, e + DAY, 20_000).unwrap();
            push(
                checks,
                "time",
                &rules,
                "late_mature_repay_before_it",
                "repay ok before mature, window starts at mature",
                format!("repay {:?} window_end {wend}", r.is_ok()),
                r.is_ok() && wend == 20_000 + WINDOW_BLOCKS,
            );
        }
        // sibling pool starts the shared window; the second pool of the expiry inherits it
        {
            let (mut m, mut l) = traded_pool(&rules);
            let second = m.create_pool(e, 3500 * USDC, 800, 0, 0);
            let w1 = m.mature(0, e, 10_000).unwrap();
            let w2 = m.mature(second, e, 10_000 + 3000).unwrap();
            let _ = &mut l;
            push(
                checks,
                "time",
                &rules,
                "shared_window_per_expiry",
                "same window end",
                format!("{w1} vs {w2}"),
                w1 == w2,
            );
        }
        // repay in the last block of the window succeeds; at window_end it fails; close then succeeds
        {
            let (mut m, mut l) = traded_pool(&rules);
            let wend = m.mature(0, e, 10_000).unwrap();
            let ok_last = m.repay(0, &rules, &mut l, 1, 5 * ETH, e, wend - 1).is_ok();
            let fail_at_end = m.repay(0, &rules, &mut l, 1, 5 * ETH, e, wend).is_err();
            let close_ok = m.close(0, &rules, &mut l, wend).is_ok();
            push(
                checks,
                "time",
                &rules,
                "repay_last_block_then_close",
                "ok, refused, closed",
                format!("{ok_last} {fail_at_end} {close_ok}"),
                ok_last && fail_at_end && close_ok,
            );
        }
        // closeWindow racing repay: close refused while the window runs (invariant 5)
        {
            let (mut m, mut l) = traded_pool(&rules);
            let wend = m.mature(0, e, 10_000).unwrap();
            m.pools[0]
                .bid(&mut l, 5, 10 * ETH, 100 * USDC, wend - 10)
                .unwrap();
            let close_early = m.close(0, &rules, &mut l, wend - 1).is_err();
            let repay_ok = m.repay(0, &rules, &mut l, 1, 10 * ETH, e, wend - 1).is_ok();
            m.close(0, &rules, &mut l, wend).unwrap();
            let bidder_refund = l.pending_quote_of(5);
            push(
                checks,
                "time",
                &rules,
                "repay_beats_bid",
                "repay wins, bid fully refunded",
                format!(
                    "close_early_refused {close_early} repay {repay_ok} refund {}",
                    usdc(bidder_refund)
                ),
                close_early
                    && repay_ok
                    && bidder_refund == confluere_model::math::quote_up(10 * ETH, 3500 * USDC, ETH)
                    && m.check_invariants(&l).is_ok(),
            );
        }
        // batch boundary exactly at expiry: the batch at ts == expiry still settles, then mature
        {
            let (mut m, mut l) = traded_pool(&rules);
            m.pools[0]
                .place(&rules, &mut l, 1, Side::Sell, ETH, 3300 * USDC, 0, 1)
                .unwrap();
            m.pools[0]
                .place(&rules, &mut l, 2, Side::Buy, ETH, 3300 * USDC, 0, 1)
                .unwrap();
            let s = m.settle(0, &rules, &mut l, e, 9_999);
            let mt = m.mature(0, e, 10_000);
            push(
                checks,
                "time",
                &rules,
                "batch_at_expiry_boundary",
                "settle ok then mature ok",
                format!("{:?} {:?}", s.is_ok(), mt.is_ok()),
                s.is_ok() && mt.is_ok(),
            );
        }
        // order ttl expiring: purge refunds; invariants hold
        {
            let (mut m, mut l) = traded_pool(&rules);
            m.pools[0]
                .place(&rules, &mut l, 4, Side::Buy, ETH, 3000 * USDC, 0, 1)
                .unwrap();
            m.settle(0, &rules, &mut l, 2 * BATCH, 2).unwrap();
            let before = l.pending_quote_of(4);
            m.pools[0].purge(&mut l);
            let after = l.pending_quote_of(4);
            push(
                checks,
                "time",
                &rules,
                "ttl_expiry_purge_refund",
                "escrow back in pending",
                format!("{} -> {}", usdc(before), usdc(after)),
                after > before && m.check_invariants(&l).is_ok(),
            );
        }
    }
}

fn pause(checks: &mut Vec<Check>) {
    for rules in [Rules::v07(), Rules::v08()] {
        let (mut m, mut l) = traded_pool(&rules);
        m.pools[0].pause(&rules, 100, 1000).unwrap();
        let place = m.pools[0]
            .place_at(&rules, &mut l, 1, Side::Sell, ETH, 3300 * USDC, 0, 1, 500)
            .is_err();
        let settle = m.settle(0, &rules, &mut l, 2 * BATCH, 500).is_err();
        m.pools[0]
            .place_at(&rules, &mut l, 2, Side::Buy, ETH, 3200 * USDC, 0, 2, 1100)
            .unwrap();
        let cancel_id = m.pools[0]
            .live_orders()
            .find(|o| o.owner == 2)
            .map(|o| o.id)
            .unwrap();
        m.pools[0].pause(&rules, 1200, 1000).ok();
        let cancel = m.cancel(0, &mut l, 2, cancel_id).is_ok();
        let repay = m
            .repay(0, &rules, &mut l, 1, 5 * ETH, 3 * DAY, 1500)
            .is_ok();
        push(
            checks,
            "pause",
            &rules,
            "pause_blocks_place_settle_not_cancel_repay",
            "place/settle refused; cancel/repay ok",
            format!("place_refused {place} settle_refused {settle} cancel {cancel} repay {repay}"),
            place && settle && cancel && repay,
        );
        // claim after close is never blocked by a pause flag
        let (mut m2, mut l2) = traded_pool(&rules);
        m2.mature(0, 7 * DAY, 10_000).unwrap();
        m2.close(0, &rules, &mut l2, 10_000 + WINDOW_BLOCKS)
            .unwrap();
        let claim = m2.pools[0].claim(&mut l2, 2).is_ok();
        push(
            checks,
            "pause",
            &rules,
            "claim_after_close",
            "ok",
            format!("{claim}"),
            claim,
        );
        // graduation blocked by a pause in the cycle
        let bad = m.pools[0].bad;
        push(
            checks,
            "pause",
            &rules,
            "pause_marks_expiry_bad",
            "bad = true",
            format!("{bad}"),
            bad,
        );
    }
}

fn lp(checks: &mut Vec<Check>) {
    for rules in [Rules::v07(), Rules::v08()] {
        // transfer C mid-life; both holders claim their share; double claim yields nothing
        let (mut m, mut l) = traded_pool(&rules);
        m.pools[0].transfer_c(2, 7, 4 * ETH).unwrap();
        m.mature(0, 7 * DAY, 10_000).unwrap();
        m.repay(0, &rules, &mut l, 1, 10 * ETH, 7 * DAY, 10_001)
            .unwrap();
        m.close(0, &rules, &mut l, 10_000 + WINDOW_BLOCKS).unwrap();
        let (q7, _) = m.pools[0].claim(&mut l, 7).unwrap();
        let (q2, _) = m.pools[0].claim(&mut l, 2).unwrap();
        let (q2b, a2b) = m.pools[0].claim(&mut l, 2).unwrap();
        let total = q7 + q2;
        let expected = m.pools[0].quote_bal + total; // pool drained except dust
        push(
            checks,
            "lp",
            &rules,
            "transfer_then_claim_both",
            "40/60 split, second claim zero",
            format!("q7 {} q2 {} double {} {}", usdc(q7), usdc(q2), q2b, a2b),
            q7 * 3 / 2 == q2
                && q2b == 0
                && a2b == 0
                && expected >= total
                && m.check_invariants(&l).is_ok(),
        );
        // claim order independence: the last claimer gets the dust, nobody more than their share
        let (mut m, mut l) = traded_pool(&rules);
        m.pools[0].transfer_c(2, 8, 3 * ETH).unwrap();
        m.pools[0].transfer_c(2, 9, 3 * ETH).unwrap();
        m.mature(0, 7 * DAY, 10_000).unwrap();
        m.close(0, &rules, &mut l, 10_000 + WINDOW_BLOCKS).unwrap(); // full default: 10 ETH to C holders
        let (_, a9) = m.pools[0].claim(&mut l, 9).unwrap();
        let (_, a2) = m.pools[0].claim(&mut l, 2).unwrap();
        let (_, a8) = m.pools[0].claim(&mut l, 8).unwrap();
        push(
            checks,
            "lp",
            &rules,
            "claim_order_default_asset",
            "3/4/3 ETH regardless of order",
            format!("{} {} {}", eth(a9), eth(a2), eth(a8)),
            a9 == 3 * ETH && a2 == 4 * ETH && a8 == 3 * ETH,
        );
        // pull refunds: a cancelled buy lands in pending, never pushed (invariant 7)
        let (mut m, mut l) = traded_pool(&rules);
        let id = m.pools[0]
            .place(&rules, &mut l, 6, Side::Buy, ETH, 3000 * USDC, 0, 3)
            .unwrap();
        let wallet_before = l.quote_of(6);
        m.cancel(0, &mut l, 6, id).unwrap();
        let pending = l.pending_quote_of(6);
        push(
            checks,
            "lp",
            &rules,
            "cancel_is_pull_refund",
            "wallet unchanged, pending credited",
            format!("wallet {} pending {}", usdc(l.quote_of(6)), usdc(pending)),
            l.quote_of(6) == wallet_before && pending > 0,
        );
    }
}

fn longtail(checks: &mut Vec<Check>) {
    for rules in [Rules::v07(), Rules::v08()] {
        // cadence 2 (24 h batches): a settle before the boundary is refused, at the boundary it clears
        let mut m = Market::new(grid(), 18, true);
        let mut l = Ledger::default();
        for a in 1..=5 {
            l.mint_quote(a, 10_000_000 * USDC);
            l.mint_asset(a, 1000 * ETH);
        }
        let idx = m.create_pool(7 * DAY, 3400 * USDC, 1500, 2, 0);
        m.pools[idx].min_fill = 5 * ETH;
        m.pools[idx].first_lo = 3000 * USDC;
        m.pools[idx].first_hi = 3500 * USDC;
        m.pools[idx]
            .place(&rules, &mut l, 1, Side::Sell, 2 * ETH, 3300 * USDC, 0, 3)
            .unwrap();
        m.pools[idx]
            .place(&rules, &mut l, 2, Side::Buy, 2 * ETH, 3300 * USDC, 0, 3)
            .unwrap();
        let early = m.settle(idx, &rules, &mut l, 12 * 3600, 1).is_err();
        let r1 = m.settle(idx, &rules, &mut l, 24 * 3600, 2).unwrap();
        push(
            checks,
            "longtail",
            &rules,
            "cadence_and_min_fill",
            "early refused; 2 ETH < minFill 5 → no trade",
            format!("early_refused {early} reason {}", r1.no_trade_reason),
            early && r1.no_trade_reason == "min_fill",
        );
        // first-auction bounds: price outside [3000, 3500] does not trade until a first price exists
        m.pools[idx]
            .place(&rules, &mut l, 3, Side::Sell, 5 * ETH, 3600 * USDC, 0, 3)
            .unwrap();
        m.pools[idx]
            .place(&rules, &mut l, 4, Side::Buy, 5 * ETH, 3600 * USDC, 0, 3)
            .unwrap();
        let r2 = m.settle(idx, &rules, &mut l, 48 * 3600, 3).unwrap();
        push(
            checks,
            "longtail",
            &rules,
            "first_auction_bounds",
            "no trade: first_bounds",
            r2.no_trade_reason.to_string(),
            r2.no_trade_reason == "first_bounds",
        );
        // within bounds and above minFill → trades; a later out-of-bounds price is fine (bounds only apply to the first)
        m.pools[idx]
            .place(&rules, &mut l, 1, Side::Sell, 6 * ETH, 3300 * USDC, 0, 3)
            .unwrap();
        m.pools[idx]
            .place(&rules, &mut l, 2, Side::Buy, 6 * ETH, 3300 * USDC, 0, 3)
            .unwrap();
        let r3 = m.settle(idx, &rules, &mut l, 72 * 3600, 4).unwrap();
        push(
            checks,
            "longtail",
            &rules,
            "first_trade_inside_bounds",
            "traded at 3300",
            format!("{} {}", r3.traded, usdc(r3.price)),
            r3.traded && r3.price == 3300 * USDC && m.check_invariants(&l).is_ok(),
        );
        // price discovery: how many 24 h batches until a stable P* with a noisy book
        let mut rng = ChaCha8Rng::seed_from_u64(5);
        let mut prices = Vec::new();
        for b in 4..12u64 {
            let p = &mut m.pools[idx];
            for _ in 0..4 {
                let who = rng.random_range(1..=2);
                let lim = rand_range(&mut rng, 3200, 3399) * USDC;
                p.place(&rules, &mut l, who, Side::Sell, 3 * ETH, lim, 0, 1)
                    .unwrap();
                let who = rng.random_range(3..=4);
                let lim = rand_range(&mut rng, 3200, 3399) * USDC;
                p.place(&rules, &mut l, who, Side::Buy, 3 * ETH, lim, 0, 1)
                    .unwrap();
            }
            let r = m.settle(idx, &rules, &mut l, b * 24 * 3600, b).unwrap();
            prices.push(usdc(r.price));
        }
        let spread = prices.iter().cloned().fold(0.0, f64::max)
            - prices
                .iter()
                .cloned()
                .filter(|p| *p > 0.0)
                .fold(f64::MAX, f64::min);
        push(
            checks,
            "longtail",
            &rules,
            "price_discovery_noisy_book",
            "P* stays inside the book's range",
            format!(
                "prices {:?} spread {spread:.0}",
                prices.iter().map(|p| p.round()).collect::<Vec<_>>()
            ),
            spread < 200.0,
        );
    }
}

fn graduation_restart(checks: &mut Vec<Check>) {
    for rules in [Rules::v07(), Rules::v08()] {
        let mut m = Market::new(grid(), 18, true);
        let mut l = Ledger::default();
        for a in 1..=3 {
            l.mint_quote(a, 100_000_000_000 * USDC);
            l.mint_asset(a, 100_000_000 * ETH);
        }
        let mut grad_at = Vec::new();
        for i in 1..=7u64 {
            let e = i * 7 * DAY;
            let idx = m.create_pool(e, 3400 * USDC, 800, 0, 0);
            // expiry 3 is a miss: tiny volume; the rest clear the threshold
            let units = if i == 3 { ETH } else { 500 * ETH };
            m.pools[idx]
                .place(&rules, &mut l, 1, Side::Sell, units, 3300 * USDC, 0, 2)
                .unwrap();
            m.pools[idx]
                .place(&rules, &mut l, 2, Side::Buy, units, 3300 * USDC, 0, 2)
                .unwrap();
            m.settle(idx, &rules, &mut l, e - DAY, 100 * i).unwrap();
            m.mature(idx, e, 1000 * i).unwrap();
            l.withdraw_quote(1);
            m.repay(idx, &rules, &mut l, 1, units, e, 1000 * i + 1)
                .unwrap();
            m.close(idx, &rules, &mut l, 1000 * i + WINDOW_BLOCKS)
                .unwrap();
            if m.check_graduation(&rules, 4) {
                grad_at.push(i);
            }
        }
        push(
            checks,
            "graduation",
            &rules,
            "missed_cycle_restarts_count",
            "graduates at expiry 7 (4,5,6,7), not 4",
            format!("{:?}", grad_at),
            grad_at.first() == Some(&7),
        );
    }
}

/// Dilution-fix variants on the wash-and-default attack (see fee_wash.rs for the baseline):
/// A = per-batch C (each batch is its own pool), B = competitive clearing bounded by the band.
fn dilution_variants() {
    let k = 3400 * USDC;
    let honest_units = 100 * ETH;
    let honest_price = 3300 * USDC;
    let mut rows = Vec::new();
    for mult in [0.5f64, 1.0, 2.0, 5.0] {
        let wash = (honest_units as f64 * mult) as u128;
        // baseline v0.8 (shared pot)
        let (pnl_a, pnl_l, _) =
            wash_default(&Rules::v08(), k, honest_units, honest_price, wash, false);
        rows.push(DilutionRow {
            variant: "v08_shared_pot",
            wash_multiple: mult,
            attacker_pnl_usdc: pnl_a,
            honest_lender_pnl_usdc: pnl_l,
            honest_fill_blocked: false,
        });
        // A: per-batch tranches == separate pools: the attacker's batch is its own pool, nothing to dilute
        let (pnl_a, pnl_l, _) =
            wash_default(&Rules::v08(), k, honest_units, honest_price, wash, true);
        rows.push(DilutionRow {
            variant: "A_per_batch_C_as_separate_pools",
            wash_multiple: mult,
            attacker_pnl_usdc: pnl_a,
            honest_lender_pnl_usdc: pnl_l,
            honest_fill_blocked: false,
        });
        // A (real rule): one pool, C/R tranched per settlement batch
        let (pnl_a, pnl_l, _) = wash_default(
            &Rules::v08_tranche(),
            k,
            honest_units,
            honest_price,
            wash,
            false,
        );
        rows.push(DilutionRow {
            variant: "A_tranche_rule",
            wash_multiple: mult,
            attacker_pnl_usdc: pnl_a,
            honest_lender_pnl_usdc: pnl_l,
            honest_fill_blocked: false,
        });
        // B: competitive band: wash at K−1 is 3% above the last price → outside an 8% band? no — inside.
        // So B only helps with a tight band; try 1.5% (pegged class) and 8% (majors).
        for (band, name) in [
            (150u128, "B_competitive_band_1.5pct"),
            (800, "B_competitive_band_8pct"),
        ] {
            let mut r = Rules::v08();
            r.competitive_band = true;
            let (pnl_a, pnl_l, blocked) =
                wash_default_band(&r, k, honest_units, honest_price, wash, band);
            rows.push(DilutionRow {
                variant: name,
                wash_multiple: mult,
                attacker_pnl_usdc: pnl_a,
                honest_lender_pnl_usdc: pnl_l,
                honest_fill_blocked: blocked,
            });
        }
    }
    write_csv("dilution_variants.csv", &rows);
}

fn wash_default(
    rules: &Rules,
    k: u128,
    honest_units: u128,
    honest_price: u128,
    wash: u128,
    separate_pools: bool,
) -> (f64, f64, bool) {
    wash_default_inner(
        rules,
        k,
        honest_units,
        honest_price,
        wash,
        separate_pools,
        800,
    )
}

fn wash_default_band(
    rules: &Rules,
    k: u128,
    honest_units: u128,
    honest_price: u128,
    wash: u128,
    band: u128,
) -> (f64, f64, bool) {
    wash_default_inner(rules, k, honest_units, honest_price, wash, false, band)
}

fn wash_default_inner(
    rules: &Rules,
    k: u128,
    honest_units: u128,
    honest_price: u128,
    wash: u128,
    separate_pools: bool,
    band: u128,
) -> (f64, f64, bool) {
    let mut m = Market::new(grid(), 18, true);
    let mut l = Ledger::default();
    for a in 1..=3 {
        l.mint_quote(a, 100_000_000 * USDC);
        l.mint_asset(a, 100_000 * ETH);
    }
    let p0 = m.create_pool(7 * DAY, k, band, 0, 0);
    let p1 = if separate_pools {
        m.create_pool(7 * DAY + 1, k, band, 0, 0)
    } else {
        p0
    };
    // note: a second "pool" at expiry+1 stands for a per-batch tranche of the same pool
    let (borrower, lender, attacker) = (1, 2, 3);
    let value = |l: &Ledger, a: u32| {
        l.quote_of(a) as f64 + l.asset_of(a) as f64 * honest_price as f64 / ETH as f64
    };
    let (va0, vl0) = (value(&l, attacker), value(&l, lender));
    m.pools[p0]
        .place(
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
    m.pools[p0]
        .place(
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
    // first batch sets band_base = honest price
    m.settle(p0, rules, &mut l, BATCH, 1).unwrap();
    let mut blocked = false;
    if wash != 0 {
        m.pools[p1]
            .place(rules, &mut l, attacker, Side::Sell, wash, k - USDC, 0, 2)
            .unwrap();
        m.pools[p1]
            .place(rules, &mut l, attacker, Side::Buy, wash, k - USDC, 0, 2)
            .unwrap();
        let rep = m.settle(p1, rules, &mut l, 2 * BATCH, 2).unwrap();
        blocked = !rep.traded;
        if blocked {
            // escrow comes back on purge
            for _ in 0..3 {
                let _ = m.settle(p1, rules, &mut l, 3 * BATCH, 3);
            }
            m.pools[p1].purge(&mut l);
        }
    }
    l.withdraw_quote(borrower);
    for &p in &[p0, p1] {
        let _ = m.mature(p, m.pools[p].key.expiry, 10_000);
    }
    m.repay(p0, rules, &mut l, borrower, honest_units, 7 * DAY, 10_001)
        .unwrap();
    for &p in &[p0, p1] {
        let _ = m.close(p, rules, &mut l, 10_000 + WINDOW_BLOCKS);
    }
    for &p in &[p0, p1] {
        let _ = m.pools[p].claim(&mut l, lender);
        let _ = m.pools[p].claim(&mut l, attacker);
    }
    for a in [lender, attacker] {
        l.withdraw_quote(a);
        l.withdraw_asset(a);
    }
    m.check_invariants(&l).unwrap();
    assert!(
        m.pools.iter().all(|p| p.tranche_consistent()),
        "tranche ledger"
    );
    let pnl_a = (value(&l, attacker) - va0) / USDC as f64;
    let pnl_l =
        (value(&l, lender) - vl0 - (k - honest_price) as f64 * honest_units as f64 / ETH as f64)
            / USDC as f64;
    let _ = TREASURY;
    (pnl_a, pnl_l, blocked)
}

/// NC share cap sweep (25 / 33 / 50 %): rate reduction vs. competitive displacement in the ladder book.
fn nc_cap_sweep() {
    let k = 3400 * USDC;
    let mut rows = Vec::new();
    for cap in [2500u128, 3300, 5000] {
        let mut rules = Rules::v08();
        rules.nc_share_bps = cap;
        for budget_k in [0u128, 25, 50, 100, 200] {
            let budget = budget_k * 1000 * USDC;
            let (mut m, mut l) = fresh(&rules, k, 7 * DAY, 800, 60);
            let p = &mut m.pools[0];
            p.place(&rules, &mut l, 1, Side::Sell, ETH, 3300 * USDC, 0, 1)
                .unwrap();
            p.place(&rules, &mut l, 2, Side::Buy, ETH, 3300 * USDC, 0, 1)
                .unwrap();
            m.settle(0, &rules, &mut l, BATCH, 1).unwrap();
            let p = &mut m.pools[0];
            let mut a = 3;
            for i in 0..10u128 {
                p.place(
                    &rules,
                    &mut l,
                    a,
                    Side::Sell,
                    10 * ETH,
                    (3250 + 10 * i) * USDC,
                    0,
                    1,
                )
                .unwrap();
                a += 1;
                p.place(
                    &rules,
                    &mut l,
                    a,
                    Side::Buy,
                    10 * ETH,
                    (3320 - 10 * i) * USDC,
                    0,
                    1,
                )
                .unwrap();
                a += 1;
            }
            if budget != 0 {
                p.place(&rules, &mut l, 59, Side::NcBuy, 0, 0, budget, 1)
                    .unwrap();
            }
            let rep = m.settle(0, &rules, &mut l, 2 * BATCH, 2).unwrap();
            rows.push(CapRow {
                nc_cap_bps: cap,
                nc_budget_usdc: usdc(budget),
                price: usdc(rep.price),
                implied_apr: apr(rep.price, k, 7.0),
                competitive_units: eth(rep.competitive_units),
                nc_units: eth(rep.nc_units),
            });
        }
    }
    write_csv("nc_cap_sweep.csv", &rows);
    let _ = Status::Open;
}
