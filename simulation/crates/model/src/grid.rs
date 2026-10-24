//! Strike grids. v0.7: "at most N significant decimal digits" (`Grid.isGridStrike`).
//! v0.8 (BLUEPRINT §3.3, 2026-10-23): logarithmic grid, K = round(1.01^n) in quote base units.

/// v0.7 rule: strip trailing zeros, the rest must fit in `sig_digits` digits.
pub fn is_sig_digit_strike(mut strike: u128, sig_digits: u32) -> bool {
    if strike == 0 {
        return false;
    }
    while strike % 10 == 0 {
        strike /= 10;
    }
    strike < 10u128.pow(sig_digits)
}

/// Relative step (in bps) between `strike` and the next strike above it on the sig-digit grid.
pub fn sig_digit_step_bps(strike: u128, sig_digits: u32) -> f64 {
    let digits = strike.to_string().len() as u32;
    let step = 10u128.pow(digits.saturating_sub(sig_digits));
    let next = (strike / step + 1) * step;
    (next - strike) as f64 / strike as f64 * 10_000.0
}

/// v0.8 rule: the grid point with index `n` (may be negative) in quote base units: round(1.01^n).
pub fn log_strike(n: i64) -> u128 {
    1.01f64.powi(n as i32).round() as u128
}

/// Index of the grid point nearest to `strike` (in log space).
pub fn log_index(strike: u128) -> i64 {
    ((strike as f64).ln() / 1.01f64.ln()).round() as i64
}

/// Snap `strike` to the nearest v0.8 grid point.
pub fn snap_log(strike: u128) -> u128 {
    log_strike(log_index(strike))
}

/// v0.8 membership with the tolerance the contract will need (rounding to the quote's smallest unit).
pub fn is_log_strike(strike: u128) -> bool {
    strike != 0 && snap_log(strike) == strike
}

/// Relative step (bps) to the next grid point above `strike` on the log grid.
pub fn log_step_bps(strike: u128) -> f64 {
    let n = log_index(strike);
    let next = log_strike(n + 1);
    (next as f64 - strike as f64) / strike as f64 * 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sig_digits() {
        assert!(is_sig_digit_strike(3_400_000_000, 2));
        assert!(!is_sig_digit_strike(3_410_000_000, 2));
        assert!(is_sig_digit_strike(980_000_000_000_000_000, 2)); // 0.98 × 1e18
                                                                  // step at 1000 is 10%, at 9900 is 1%
        assert!((sig_digit_step_bps(1000, 2) - 1000.0).abs() < 1e-9);
        assert!((sig_digit_step_bps(9900, 2) - 101.01).abs() < 0.1);
    }

    #[test]
    fn log_grid() {
        let k = snap_log(3_400_000_000);
        assert!(is_log_strike(k));
        let step = log_step_bps(k);
        assert!(step > 99.0 && step < 101.0, "step {step}");
        // 0.98 and 0.99 (×1e18) are on the grid within rounding
        for r in [0.97f64, 0.98, 0.99] {
            let s = (r * 1e18) as u128;
            let snapped = snap_log(s);
            let rel = (snapped as f64 - s as f64).abs() / s as f64;
            assert!(rel < 0.005, "{r}: {rel}");
        }
    }
}
