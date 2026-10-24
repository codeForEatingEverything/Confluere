//! BLUEPRINT §4.2 (2026-10-23): non-competitive buy budgets join the demand curve. Sweep the retail /
//! vault budget against a fixed competitive book and record P*, the implied borrow rate and how much of
//! the NC budget was priced in vs. only filled at P*.

use crate::common::*;
use confluere_model::{Rules, Side};
use serde::Serialize;

#[derive(Serialize)]
struct Row {
    rules: &'static str,
    book: &'static str,
    nc_budget_usdc: f64,
    nc_budget_units_at_ref: f64,
    competitive_units: f64,
    price: f64,
    implied_apr: f64,
    nc_units_in_pricing: f64,
    nc_units_filled: f64,
    nc_share_of_competitive: f64,
    nc_budget_unfilled_pct: f64,
}

struct Book {
    name: &'static str,
    sells: Vec<(u128, u128)>, // (units, limit)
    buys: Vec<(u128, u128)>,
}

pub fn run() {
    let k = 3400 * USDC;
    let expiry = 7 * DAY;
    let books = [
        Book {
            name: "ladder",
            sells: (0..10)
                .map(|i| (10 * ETH, (3250 + 10 * i) * USDC))
                .collect(),
            buys: (0..10)
                .map(|i| (10 * ETH, (3320 - 10 * i) * USDC))
                .collect(),
        },
        Book {
            name: "thin_supply",
            sells: vec![
                (20 * ETH, 3280 * USDC),
                (5 * ETH, 3300 * USDC),
                (5 * ETH, 3380 * USDC),
            ],
            buys: vec![
                (10 * ETH, 3290 * USDC),
                (10 * ETH, 3270 * USDC),
                (30 * ETH, 3250 * USDC),
            ],
        },
        Book {
            name: "deep_supply",
            sells: (0..20).map(|i| (10 * ETH, (3200 + 5 * i) * USDC)).collect(),
            buys: vec![(10 * ETH, 3260 * USDC), (10 * ETH, 3240 * USDC)],
        },
    ];
    let mut rows = Vec::new();
    for rules in [Rules::v07(), Rules::v08()] {
        for book in &books {
            for budget_k in [0u128, 10, 25, 50, 100, 150, 200, 300, 500, 1000] {
                let budget = budget_k * 1000 * USDC;
                let (mut m, mut l) = fresh(&rules, k, expiry, 800, 60);
                let p = &mut m.pools[0];
                // establish a band base at 3300
                p.place(&rules, &mut l, 1, Side::Sell, ETH, 3300 * USDC, 0, 1)
                    .unwrap();
                p.place(&rules, &mut l, 2, Side::Buy, ETH, 3300 * USDC, 0, 1)
                    .unwrap();
                p.settle(&rules, &mut l, BATCH, 1).unwrap();
                let mut a = 3;
                for (u, lim) in &book.sells {
                    p.place(&rules, &mut l, a, Side::Sell, *u, *lim, 0, 1)
                        .unwrap();
                    a += 1;
                }
                for (u, lim) in &book.buys {
                    p.place(&rules, &mut l, a, Side::Buy, *u, *lim, 0, 1)
                        .unwrap();
                    a += 1;
                }
                if budget != 0 {
                    p.place(&rules, &mut l, 59, Side::NcBuy, 0, 0, budget, 1)
                        .unwrap();
                }
                let rep = p.settle(&rules, &mut l, 2 * BATCH, 2).unwrap();
                m.check_invariants(&l).unwrap();
                let nc_filled = rep.nc_units;
                let spent = if rep.traded {
                    confluere_model::math::quote_up(nc_filled, rep.price, ETH)
                } else {
                    0
                };
                rows.push(Row {
                    rules: rules.name(),
                    book: book.name,
                    nc_budget_usdc: usdc(budget),
                    nc_budget_units_at_ref: budget as f64 / (3300.0 * USDC as f64),
                    competitive_units: eth(rep.competitive_units),
                    price: usdc(rep.price),
                    implied_apr: if rep.traded {
                        apr(rep.price, k, 7.0)
                    } else {
                        f64::NAN
                    },
                    nc_units_in_pricing: eth(rep.nc_buy_units_in_pricing),
                    nc_units_filled: eth(nc_filled),
                    nc_share_of_competitive: if rep.competitive_units == 0 {
                        0.0
                    } else {
                        nc_filled as f64 / rep.competitive_units as f64
                    },
                    nc_budget_unfilled_pct: if budget == 0 {
                        0.0
                    } else {
                        (1.0 - spent as f64 / budget as f64) * 100.0
                    },
                });
            }
        }
    }
    write_csv("nc_pricing.csv", &rows);
}
