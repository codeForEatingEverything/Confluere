//! Section 3 "Feasibility", seat economics (BLUEPRINT §9, 2026-10-23 numbers): a seat gets 70% (pre-graduation)
//! or 35% (post) of the market's treasury revenue, pays 15%/yr Harberger tax on its self-declared price and must
//! post a competitive buy ≥ 10% of last expiry's average batch volume every batch (capital tied up, with the
//! lender's expected return on it). Also the bootstrap market maker's budget to cover a market until a seat shows up.

use crate::common::*;
use confluere_model::Rules;
use serde::Serialize;

#[derive(Serialize)]
struct SeatRow {
    weekly_volume_usdc: f64,
    apr: f64,
    graduated: bool,
    market_revenue_yearly_usdc: f64,
    seat_share: f64,
    seat_income_yearly_usdc: f64,
    obligation_per_batch_usdc: f64,
    obligation_capital_usdc: f64,
    expected_lender_return_on_obligation_usdc: f64,
    breakeven_seat_price_usdc: f64,
    seat_price_at_12pct_required_return_usdc: f64,
    viable: bool,
}

#[derive(Serialize)]
struct BootstrapRow {
    weekly_volume_usdc: f64,
    batches_per_week: f64,
    mm_bid_per_batch_usdc: f64,
    mm_capital_usdc: f64,
    spread_pct: f64,
    expected_weekly_pnl_usdc: f64,
    weeks_until_seat_or_exit: u32,
    budget_usdc: f64,
}

pub fn run() {
    let rules = Rules::v08();
    let (spread_bps, trade_ppm) = match rules.fee {
        confluere_model::rules::FeeRule::PerFillEscrow {
            spread_bps,
            trade_ppm_each_side,
        } => (spread_bps, trade_ppm_each_side),
        _ => unreachable!(),
    };
    let mut rows = Vec::new();
    for v in [
        100_000.0f64,
        300_000.0,
        1_000_000.0,
        3_000_000.0,
        10_000_000.0,
    ] {
        for apr in [0.02f64, 0.05, 0.10] {
            for grad in [false, true] {
                let interest = v * apr * 7.0 / 365.0;
                let weekly =
                    interest * spread_bps as f64 / 10_000.0 + v * 2.0 * trade_ppm as f64 / 1e6;
                let yearly = weekly * 52.0;
                let share = if grad { 0.35 } else { 0.70 };
                let income = yearly * share;
                // obligation: 10% of last expiry's average batch volume, posted every batch (336 batches / week)
                let batches = 7.0 * 48.0;
                let per_batch = v / batches * 0.10;
                // capital: the bid must be escrowed every batch; when it fills, the C is held to expiry (7 days),
                // so the standing requirement is one week of fills ≈ per_batch × batches × (fill probability).
                let fill_prob = 0.5;
                let capital = per_batch * batches * fill_prob;
                let lender_return = capital * apr; // earned as a lender anyway
                                                   // Harberger: tax = 15% × price per year. Break-even price: income = 0.15 × price.
                let be = income / 0.15;
                // requiring 12%/yr on the price paid on top of the tax: income = (0.15 + 0.12) × price
                let p12 = income / 0.27;
                rows.push(SeatRow {
                    weekly_volume_usdc: v,
                    apr,
                    graduated: grad,
                    market_revenue_yearly_usdc: yearly,
                    seat_share: share,
                    seat_income_yearly_usdc: income,
                    obligation_per_batch_usdc: per_batch,
                    obligation_capital_usdc: capital,
                    expected_lender_return_on_obligation_usdc: lender_return,
                    breakeven_seat_price_usdc: be,
                    seat_price_at_12pct_required_return_usdc: p12,
                    // a seat is "viable" if someone would pay at least 1,000 USDC for it at a 12% return
                    viable: p12 >= 1000.0,
                });
            }
        }
    }
    write_csv("seats.csv", &rows);
    // bootstrap MM: posts a competitive buy per batch at last price − spread (0.5% majors), capped per batch;
    // its expected P&L is the discount it earns on fills minus defaults it eats; budget = capital + loss buffer
    let mut mm = Vec::new();
    for v in [100_000.0f64, 300_000.0, 1_000_000.0] {
        let batches = 7.0 * 48.0;
        let bid = v / batches * 0.5; // covers up to half a batch
        let capital = bid * batches * 0.5;
        let spread = 0.5;
        // earns spread on filled volume (half the market), loses on defaults at a 10% default rate × 3% depth
        let weekly_pnl = v * 0.5 * spread / 100.0 - v * 0.5 * 0.10 * 0.03;
        let weeks = if v >= 1_000_000.0 { 8 } else { 26 };
        mm.push(BootstrapRow {
            weekly_volume_usdc: v,
            batches_per_week: batches,
            mm_bid_per_batch_usdc: bid,
            mm_capital_usdc: capital,
            spread_pct: spread,
            expected_weekly_pnl_usdc: weekly_pnl,
            weeks_until_seat_or_exit: weeks,
            budget_usdc: capital + (weekly_pnl.min(0.0).abs() * weeks as f64) + capital * 0.1,
        });
    }
    write_csv("bootstrap_mm.csv", &mm);
}
