//! Smaller single-table scenarios: strike grid step sizes, guardian pause cap, revenue magnitudes.

use crate::common::*;
use confluere_model::grid as g;
use confluere_model::Rules;
use serde::Serialize;

#[derive(Serialize)]
struct GridRow {
    price_usdc: f64,
    sig2_step_bps: f64,
    log_step_bps: f64,
    sig2_nearest: f64,
    log_nearest: f64,
}

pub fn grid() {
    let mut rows = Vec::new();
    // ETH-class prices and LST ratios (×1e18 as the contracts would see a ratio strike)
    let mut prices: Vec<u128> = Vec::new();
    let mut p = 100.0f64;
    while p < 150_000.0 {
        prices.push((p * USDC as f64) as u128);
        p *= 1.08;
    }
    for r in 90..=112u128 {
        prices.push(r * 10u128.pow(16)); // 0.90 … 1.12 ratios with 18 decimals
    }
    for pr in prices {
        // nearest 2-significant-digit strike at or below pr
        let digits = pr.to_string().len() as u32;
        let step = 10u128.pow(digits.saturating_sub(2));
        let near = pr / step * step;
        debug_assert!(g::is_sig_digit_strike(near, 2));
        rows.push(GridRow {
            price_usdc: if pr >= 10u128.pow(15) {
                pr as f64 / 1e18
            } else {
                usdc(pr)
            },
            sig2_step_bps: g::sig_digit_step_bps(near, 2),
            log_step_bps: g::log_step_bps(g::snap_log(pr)),
            sig2_nearest: if pr >= 10u128.pow(15) {
                near as f64 / 1e18
            } else {
                usdc(near)
            },
            log_nearest: if pr >= 10u128.pow(15) {
                g::snap_log(pr) as f64 / 1e18
            } else {
                usdc(g::snap_log(pr))
            },
        });
    }
    write_csv("grid.csv", &rows);
}

#[derive(Serialize)]
struct PauseRow {
    rules: &'static str,
    block: u64,
    paused: bool,
    paused_total_blocks: u64,
    renewals_accepted: u32,
    renewals_rejected: u32,
}

/// A guardian that renews the pause every time it is about to lapse, for a 7-day pool (604,800 blocks at 1 s).
pub fn pause() {
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        let (mut m, _l) = fresh(&rules, 3400 * USDC, 7 * DAY, 800, 1);
        let p = &mut m.pools[0];
        let (mut acc, mut rej) = (0u32, 0u32);
        let horizon = 7 * DAY; // one block per second
        let mut block = 0u64;
        while block <= horizon {
            if block + 100 >= p.paused_until {
                match p.pause(&rules, block, MAX_PAUSE_BLOCKS) {
                    Ok(_) => acc += 1,
                    Err(_) => rej += 1,
                }
            }
            if block % 3600 == 0 {
                rows.push(PauseRow {
                    rules: rules.name(),
                    block,
                    paused: p.is_paused(block),
                    paused_total_blocks: p.paused_total,
                    renewals_accepted: acc,
                    renewals_rejected: rej,
                });
            }
            block += 100;
        }
    }
    write_csv("pause.csv", &rows);
}

#[derive(Serialize)]
struct RevenueRow {
    rules: &'static str,
    weekly_volume_usdc: f64,
    apr: f64,
    default_ratio: f64,
    weekly_interest_usdc: f64,
    spread_share_usdc: f64,
    trade_fee_usdc: f64,
    treasury_weekly_usdc: f64,
    treasury_yearly_usdc: f64,
    seat_share_pre_grad_usdc_yearly: f64,
    seat_share_post_grad_usdc_yearly: f64,
}

/// BLUEPRINT §8 magnitudes: closed form, no simulation needed.
pub fn revenue() {
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for v in [100_000.0f64, 1_000_000.0, 10_000_000.0] {
            for apr in [0.02f64, 0.05, 0.10] {
                for d in [0.0f64, 0.1, 0.3] {
                    let interest = v * apr * 7.0 / 365.0;
                    let (spread, trade) = match rules.fee {
                        confluere_model::rules::FeeRule::VwapOnRepay { fee_bps } => {
                            (interest * (1.0 - d) * fee_bps as f64 / 10_000.0, 0.0)
                        }
                        confluere_model::rules::FeeRule::PerFillEscrow {
                            spread_bps,
                            trade_ppm_each_side,
                        } => (
                            interest * (1.0 - d) * spread_bps as f64 / 10_000.0,
                            v * 2.0 * trade_ppm_each_side as f64 / 1e6,
                        ),
                    };
                    let weekly = spread + trade;
                    rows.push(RevenueRow {
                        rules: rules.name(),
                        weekly_volume_usdc: v,
                        apr,
                        default_ratio: d,
                        weekly_interest_usdc: interest,
                        spread_share_usdc: spread,
                        trade_fee_usdc: trade,
                        treasury_weekly_usdc: weekly,
                        treasury_yearly_usdc: weekly * 52.0,
                        seat_share_pre_grad_usdc_yearly: weekly * 52.0 * 0.70,
                        seat_share_post_grad_usdc_yearly: weekly * 52.0 * 0.35,
                    });
                }
            }
        }
    }
    write_csv("revenue.csv", &rows);
}
