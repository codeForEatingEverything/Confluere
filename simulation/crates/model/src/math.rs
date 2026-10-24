//! Integer arithmetic mirroring `contracts/src/libraries/Clearing.sol` and `Settlement.sol`.
//! All amounts are base units (`u128`); intermediates go through `U256` so nothing overflows.

use alloy_primitives::U256;

pub const BPS: u128 = 10_000;

fn u(x: u128) -> U256 {
    U256::from(x)
}

/// `a * b / d`, rounded down.
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    assert!(d != 0, "mul_div by zero");
    (u(a) * u(b) / u(d)).to::<u128>()
}

/// `a * b / d`, rounded up.
pub fn mul_div_up(a: u128, b: u128, d: u128) -> u128 {
    assert!(d != 0, "mul_div_up by zero");
    let p = u(a) * u(b);
    let q = p / u(d);
    let r = if p % u(d) == U256::ZERO {
        q
    } else {
        q + U256::from(1)
    };
    r.to::<u128>()
}

/// Quote a seller receives for `units` at `price` (rounded down). `scale = 10^assetDecimals`.
pub fn quote_down(units: u128, price: u128, scale: u128) -> u128 {
    mul_div(units, price, scale)
}

/// Quote a buyer pays for `units` at `price` (rounded up).
pub fn quote_up(units: u128, price: u128, scale: u128) -> u128 {
    mul_div_up(units, price, scale)
}

/// Units a quote budget buys at `price` (rounded down).
pub fn units_for(budget: u128, price: u128, scale: u128) -> u128 {
    mul_div(budget, scale, price)
}

/// k = 0.5 double auction: midpoint of the marginal sell and buy limits.
pub fn midpoint(marginal_sell: u128, marginal_buy: u128) -> u128 {
    (marginal_sell + marginal_buy) / 2
}

/// Band after `failures` consecutive out-of-band batches: base × 1.5^failures, capped at 100%.
pub fn widened_band(band_bps: u128, failures: u32) -> u128 {
    let mut b = band_bps;
    for _ in 0..failures {
        b = b * 3 / 2;
    }
    b.min(BPS)
}

pub fn within_band(price: u128, base: u128, band_bps: u128) -> bool {
    u(price) * u(BPS) >= u(base) * u(BPS - band_bps)
        && u(price) * u(BPS) <= u(base) * u(BPS + band_bps)
}

/// Repayment for `units` at strike `k`, rounded up.
pub fn repay_amount(units: u128, k: u128, scale: u128) -> u128 {
    mul_div_up(units, k, scale)
}

/// v0.7 spread share: `feeBps` of `(K − vwap) × units`; zero when `vwap ≥ K`.
pub fn fee_v07(units: u128, k: u128, vwap: u128, fee_bps: u128, scale: u128) -> u128 {
    if k <= vwap {
        return 0;
    }
    (u(units) * u(k - vwap) * u(fee_bps) / (u(scale) * u(BPS))).to::<u128>()
}

/// Pro-rata share of a remaining balance.
pub fn share(amount: u128, balance: u128, supply: u128) -> u128 {
    if supply == 0 {
        0
    } else {
        mul_div(amount, balance, supply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding() {
        assert_eq!(mul_div(10, 3, 4), 7);
        assert_eq!(mul_div_up(10, 3, 4), 8);
        assert_eq!(mul_div_up(8, 3, 4), 6);
        assert_eq!(midpoint(100, 110), 105);
        assert_eq!(widened_band(800, 2), 1800);
        assert_eq!(widened_band(1500, 10), BPS);
    }

    #[test]
    fn band() {
        assert!(within_band(1080, 1000, 800));
        assert!(!within_band(1081, 1000, 800));
        assert!(within_band(920, 1000, 800));
    }

    #[test]
    fn v07_fee_never_underflows() {
        assert_eq!(fee_v07(10, 100, 120, 1000, 1), 0);
        assert_eq!(fee_v07(10, 100, 90, 1000, 1), 10);
    }
}
