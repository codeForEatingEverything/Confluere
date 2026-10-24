//! BLUEPRINT §10 (2026-10-23): graduation by fees paid instead of volume. For a market with honest weekly
//! volume V at a given rate, how much must an attacker add to graduate, and what does it cost them?

use crate::common::*;
use confluere_model::Rules;
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    honest_weekly_volume_usdc: f64,
    honest_apr: f64,
    honest_metric: f64,
    threshold: f64,
    graduates_honestly: bool,
    wash_volume_needed_usdc: f64,
    attacker_cost_per_expiry_usdc: f64,
    attacker_cost_4_expiries_usdc: f64,
}

pub fn run() {
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for v_k in [10u128, 50, 100, 200, 300, 500, 1000] {
            for apr in [0.02f64, 0.05, 0.10] {
                let v = v_k * 1000 * USDC;
                // weekly interest = V × apr × 7/365; all repaid (fees are highest then)
                let interest = v as f64 * apr * 7.0 / 365.0;
                let (metric, threshold, wash, cost1) = match rules.graduation {
                    confluere_model::rules::GradRule::Volume(t) => {
                        let need = (t as f64 - v as f64).max(0.0);
                        // v0.7: wash trading pays nothing but gas (fee is on repay of (K − vwap), and the
                        // attacker trades at K − ε so their own fee is ~0)
                        (v as f64, t as f64, need, 0.0)
                    }
                    confluere_model::rules::GradRule::Fees(t) => {
                        let fees = interest * 0.05 + v as f64 * 0.0003;
                        let need_fee = (t as f64 - fees).max(0.0);
                        // wash at K − ε: spread share ≈ 0, trade fee 0.03% → volume = fee / 0.0003
                        (fees, t as f64, need_fee / 0.0003, need_fee)
                    }
                };
                rows.push(Row {
                    rules: rules.name(),
                    honest_weekly_volume_usdc: usdc(v),
                    honest_apr: apr,
                    honest_metric: metric / USDC as f64,
                    threshold: threshold / USDC as f64,
                    graduates_honestly: metric >= threshold,
                    wash_volume_needed_usdc: wash / USDC as f64,
                    attacker_cost_per_expiry_usdc: cost1 / USDC as f64,
                    attacker_cost_4_expiries_usdc: cost1 * 4.0 / USDC as f64,
                });
            }
        }
    }
    write_csv("graduation.csv", &rows);
}
