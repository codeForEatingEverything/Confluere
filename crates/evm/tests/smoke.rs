use alloy_primitives::U256;
use confluere_evm::*;

const USDC: u128 = 1_000_000;
const ETH: u128 = 1_000_000_000_000_000_000;

#[test]
fn deploy_trade_repay_claim() {
    let grid = GridConfig {
        anchor: 0,
        period: 7 * 86_400,
        batchInterval: 1800,
        maxExpiries: 4,
        strikeSigDigits: 2,
    };
    let mut h = Harness::new(grid, 100, 1, 7200, 18, 6).unwrap();
    let borrower = addr(1);
    let lender = addr(2);
    h.mint(h.asset, borrower, U256::from(100 * ETH)).unwrap();
    h.mint(h.quote, borrower, U256::from(1_000_000 * USDC))
        .unwrap();
    h.mint(h.quote, lender, U256::from(1_000_000 * USDC))
        .unwrap();
    h.mint(h.asset, addr(9), U256::from(ETH)).unwrap();
    h.mint(h.quote, addr(9), U256::from(USDC)).unwrap();
    let expiry = 7 * 86_400;
    let pool = h
        .create_pool(addr(9), expiry, 3400 * USDC, true, 1000, 800)
        .unwrap();
    h.place(borrower, pool, SELL, 10 * ETH, 3300 * USDC, 0, 4)
        .unwrap();
    h.place(lender, pool, BUY, 10 * ETH, 3350 * USDC, 0, 4)
        .unwrap();
    h.warp(1800, 10);
    let gas = h.settle(pool).unwrap();
    let v = h.pool_view(pool).unwrap();
    assert_eq!(U256::from(v.lastClearingPrice), U256::from(3325 * USDC));
    assert_eq!(
        h.position(borrower, pool, true).unwrap(),
        U256::from(10 * ETH)
    );
    assert_eq!(
        h.position(lender, pool, false).unwrap(),
        U256::from(10 * ETH)
    );
    assert_eq!(
        h.pending(h.quote, borrower).unwrap(),
        U256::from(33_250 * USDC)
    );
    println!("settleBatch gas {gas}");
    h.warp(expiry, 100);
    h.mature(pool).unwrap();
    h.repay(borrower, pool, 10 * ETH).unwrap();
    // v0.7 fee: (3400 − 3325) × 10 × 10% = 75 USDC
    assert_eq!(
        h.pending(h.quote, h.treasury).unwrap(),
        U256::from(75 * USDC)
    );
    h.warp(expiry + 7200, 100 + 7200);
    assert!(h.close_window(pool).unwrap());
    let (q, a) = h.claim(lender, pool).unwrap();
    assert_eq!(q, U256::from(34_000 * USDC - 75 * USDC));
    assert_eq!(a, U256::ZERO);
}
