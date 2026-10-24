<h1 align="center">Simulation-Confluere</h1>

<p align="center">
<a href="https://alloy.rs"><img src="https://img.shields.io/badge/Alloy-Framework-orange?logo=rust" alt="alloy"></a>
<a href="https://bluealloy.github.io/revm"><img src="https://img.shields.io/badge/revm-EVM-yellow?logo=ethereum" alt="revm"></a>
<a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-language-red?logo=rust" alt="Rust"></a>
<a href="https://jupyter.org"><img src="https://img.shields.io/badge/Jupyter-Notebook-blue?logo=jupyter" alt="JupyterNotebook"></a>
</p>

> [!NOTE]
> This repository is designed for test and research in general for [Confluere](https://github.com/codeForEatingEverything/Confluere)

## How it works

The compiled Confluere contracts (core + linked logic libraries + periphery) are loaded into an in-process **revm** instance; scenarios are driven from Rust through **Alloy** bindings (actors, order flow, block advancement, token mints). Each scenario writes its traces (per-batch clearing price, fills, balances, fees, gas) to Parquet/CSV, and the **Jupyter notebooks** read those files to plot and compare. Nothing here touches a live chain.

Every scenario is checked against the on-chain invariant table (Confluere `ARCHITECTURE.md` §2.11) after each block; a violated invariant fails the run.

The mechanism decisions of 2026-10-23 (BLUEPRINT v0.8, IMPLEMENTATION_NOTES §8) are modelled as `Rules::v08()` in `crates/model`; the deployed contracts are `Rules::v07()`. Every scenario runs both so the change can be compared before it is written in Solidity. Items marked **⏳** still depend on open founder decisions.

## Results so far (2026-10-24)

| Scenario | CSV | Finding |
|---|---|---|
| Model vs. contracts | `crosscheck.csv` | 180 random batches in revm: P*, fills, R/C balances and pending refunds identical to the Rust model under v0.7 rules. The model is a faithful base for the v0.8 what-ifs. |
| Baseline lifecycle | `baseline_*.csv` | Full-default pools pay the treasury 0 under v0.7, ~0.03 % of volume under v0.8. When borrowers repay, v0.7 (10 % of interest) earns more than v0.8 (5 % + 0.03 %). Lender return is slightly higher under v0.8 because defaulted units' spread escrow stays with C holders. |
| NC buy demand in pricing | `nc_pricing.csv` | v0.7: a retail/vault budget never trades when the competitive book crosses exactly (needs leftovers). v0.8: it fills up to 50 % of competitive volume and lowers the implied borrow APR (1.83 % → 1.66 % in the ladder book) — while displacing competitive lenders (40 → 30 ETH filled). |
| Wash trading (M-2) | `fee_wash.csv` | v0.7: wash at K − 1 cuts the honest borrower's fee by 50 % (1× wash) to 94 % (20×). v0.8: the honest fee is untouched and the protocol earns the trade fee. **But wash-and-default is profitable under both**: see below. |
| Vault tier selection | `vault_tier.csv` | v0.7 (lowest/highest traded) is hijacked by a 20 USDC wash. v0.8 (main tier by volume) ignores it, but out-volume-ing the main tier (400 k × 2 expiries) costs only ~246 USDC in fees and sends **both** vaults to a K = 2× market pool. |
| Graduation | `graduation.csv` | Fee-based threshold: graduating an empty market costs ~600 USDC over 4 expiries (v0.7: gas only). 150 USDC/expiry ≈ 500 k volume at 5 % APR, as the blueprint says. |
| Strike grid | `grid.csv` | 2-digit grid steps 1 %–10 %, jumping to 10 % where LST ratios cross 1.0; the log grid is 1 % everywhere. |
| Guardian pause | `pause.csv` | v0.7: 13 renewals keep a 7-day pool paused for its whole life. v0.8: one 7-day pause, 5,546 renewal attempts rejected. |
| Earn vault | `earn.csv`, `earn_threshold_buyer.csv` | v0.7 vaults never fill when the competitive book crosses exactly (NAV stays 1.0); v0.8 vaults fill through the demand curve. The Low/main vault sits out when the market trades above K. In a bear path the High vault ends with asset for auto-sale plus a fallback remainder; redemption queue always clears. The ❌ APY-threshold buyer buys 336 of 336 batches in a bear market and 6 in a bull market: adverse selection confirmed. |
| Looping | `loop.csv`, `loop_edges.csv` | 8 loops at K 0.98 / sell 0.97 give 7.4× exposure for 7.2 native of interest per 100 LST; break-even needs the rate to rise < 1 %. Depeg to 0.95 → rational default, lender keeps LST. Partial repay, out-of-quote unwind and rollover of a looped position all behave; v0.8 fills the rollover in the last pre-expiry batch, v0.7 only in the window. |
| Flash loan (revm) | `flashloan.csv` | Full core balance borrowable at 0.05 %; over-balance and non-repaying borrower revert with every balance untouched; fee lands in the treasury's pending balance. |
| Rollover | `rollover.csv` | Insufficient top-up is rejected at placement. 24 h pools under v0.7 default in 18 of 36 cases (one batch boundary in a 2 h window); v0.8's last-pre-expiry-batch rule fills all of them. One case replayed on the real bytecode matches the model exactly. |
| Abandonment auction | `abandonment.csv` | Bids ranked by premium return 62.5 % of the residual to forgetful R holders with 3 bidders; over-bidders are refunded via pending. Replayed in revm: surplus, refunds and asset payout identical. |
| Edge checks | `edge_checks.csv`, `edge_extreme.csv` | 36/36 pass: chain halt freezes the window, late mature, shared window per expiry, last-block repay, repay beats bid, boundary batch, ttl purge, pause blocks place/settle but not cancel/repay/claim, C transfer + double claim, claim order, pull refunds, cadence + minFill + first-auction bounds, graduation restart after a missed cycle. −50 % crash: 3 band failures trip the breaker, the 4th price resets it. |
| Dilution-fix variants | `dilution_variants.csv`, `fee_wash.csv` (`v08_tranche`), `baseline_summary.csv`, `chaos.csv` | A (per-batch C/R tranches) is implemented as a real rule (`Rules::v08_tranche()`: each settlement's C/R are a tranche; repay, bids and the fee escrow settle per tranche; claim pays each tranche's own quote and asset). Wash-and-default: attacker P&L +5,019 → −102 USDC, honest lender −4,923 → −50 (fees only), identical to the separate-pools approximation. Honest-flow results are unchanged against v0.8 (same default ratios, treasury within 1.5 %, lender return within 0.01 pp) and the chaos run under the tranche rule passes with 0 violations and a consistent per-tranche ledger. B (band on competitive clearing) blocks the wash only at a 1.5 % band, not at 8 %. Cost of A not measured here: C is no longer fungible across batches (secondary market and wrapper list per batch). |
| NC cap sweep | `nc_cap_sweep.csv` | 25 % cap: APR 1.83 → 1.74 %, competitive fills untouched (40 ETH); 33 %: 36.8 ETH; 50 %: 1.66 %, 30 ETH. |
| Chaos | `chaos.csv` | 6 seeds × 3 rule sets (v0.7, v0.8, v0.8 + tranches), 8 expiries × 4 strikes, ~18k settles each with 10 % keeper outages, pauses, rollovers, bids, wash attacker: 2,750 invariant checks per run, 0 violations, 0 stranded funds. |
| Security (revm + model) | `security_checks.csv`, `security_m1_band.csv` | 13/13 checks pass on the real bytecode: re-entering the core from the flash-loan callback (settleBatch, repay, withdraw, placeOrder, nested flashLoan, claim) always reverts while the outer loan completes; a hostile token re-entering during the createPool probe or placeOrder's pull cannot settle; 1-wei orders are refused, 0.001 ETH dust fills the 128-slot book but a better-priced honest order still evicts in and a worse-priced one gets BookFull; settling a full dust book costs 0.37 M gas; the 65th bid at MAX_BIDS is refused unless it beats the lowest. M-1: under v0.7 a 15 % band pool lets wash pushes of 1–4 % above fair reach retail NC buyers and no 1.5 % pool can coexist; under v0.8 (band in the pool id) the honest 1.5 % pool coexists and blocks pushes ≥ 2 %. |
| Seat economics | `seats.csv`, `bootstrap_mm.csv` | At 5 % APR a seat on a 1 M/week market earns ~12.7 k/yr pre-graduation (6.3 k post), worth ~47 k (23 k) at a 12 % required return after the 15 % Harberger tax, with ~50 k of obligation capital; 100 k/week markets still clear the 1,000 USDC viability line pre-graduation (4.7 k). Bootstrap MM budget: ~27 k for a 100 k/week market over 26 weeks, ~275 k for 1 M/week over 8 weeks. |
| Gas (revm) | `gas.csv`, `keeper_cost.csv` | settleBatch: 0.36 M gas for 2 orders, 7.8 M for 128, 15.3 M for 256 (full book); closeWindow: 67 k with no bids, 2.57 M with 64. |

**Key finding — pooled C socialises default losses (both versions), and the tested fix.** An attacker sells W ETH to themself at K − 1 (one batch) and defaults at expiry; their C claims the asset back, so the only cost is the v0.8 trade fee (0.06 % of notional, 0 under v0.7). Because C is fungible per pool, the defaulted units take a pro-rata share of the honest borrower's repaid K: with 100 ETH honest volume at 3300 and K = 3400, a 100 ETH wash earns the attacker ≈ 4,750 USDC (v0.7) / ≈ 5,019 USDC (v0.8) and costs the honest lender ≈ 5,250 / ≈ 4,923 USDC — 1.5 % of what they lent. The 0.03 % fee does not deter it. Variant A (per-batch tranches) removes the profit entirely and passes the full suite (row "Dilution-fix variants"); variant B only works for pegged-class bands. This repository adopts A as its recommended rule set (`Rules::recommended()`, 2026-10-24); the trade-off is cross-batch fungibility of C, and the founder can revert it with one flag (`DECISION_wash_and_default.md`).

Charts and notebooks: `python3 notebooks/plots_stdlib.py` renders 28 SVGs into `out/plots/` with the standard library only; `python3 notebooks/run_stdlib.py` executes the six notebooks (60 code cells: tables + embedded charts) without Jupyter or pandas, which could not be installed on the authoring machine (pypi unreachable). The executed notebooks are committed with their outputs.

**Modelling assumptions worth confirming** (documented in `crates/model/src/pool.rs`): when NC buy demand enters pricing, P* still uses the marginal *competitive* pair (NC demand has no limit); at least one competitive buy must fill or there is no price; the NC share is iterated to a fixed point because the 50 % cap depends on the competitive volume it changes. ARCHITECTURE §2.4 does not yet pin these down.

## Table of Content

### 1. Basic Implementations
- [x] **Average borrow and redeem work & Analysis** (BLUEPRINT §3.4, §3.5, §8)
  - Single pool, N borrowers / M lenders with random limits; run every batch to expiry; American and European side by side.
  - Measure: clearing price `P*` per batch (midpoint rule, marginal pro-rata), fill ratio, effective borrow APR implied by `K − P*`, repay vs default split, fee actually collected vs `(K − vwap) × feeBps`.
  - Verify: dust from round-down stays in the pool (≥ invariants); fee is zero on default; `repay` never underflows.
- [x] **Earn module's work & Analysis** (BLUEPRINT §5)
  - One ERC-7540 vault investing only in a graduated pool, non-competitive buy orders only, ≤ 25% of idle funds per batch.
  - Measure: share NAV over time, redemption queue latency (request → claimable), amount of defaulted asset handed to redeemers, fill rate of the vault's orders inside the band.
  - Verify: queued redemptions are reserved before investing; vault never holds R; vault is a no-op when the pool is not graduated.
- [x] **Looping's average work & Analysis** (BLUEPRINT §7.1)
  - LST/native pair (kHYPE/HYPE, shMON/MON, wstETH/WETH), American pool, 98% strike, repeated borrow → re-deposit cycles through the Router.
  - Measure: achieved leverage per loop count, cumulative discount cost, gas per loop, worst-case outcome at expiry when the LST is not repurchased.
- [x] **LP's work & Analysis** (lender side: C-Token holder, BLUEPRINT §3.1, §3.6)
  - Measure: C-Token payoff curve vs asset price at expiry (bond + short put), claim composition (quote + defaulted asset), time to claim after `closeWindow`.
  - Secondary market: C/R transfer and `PositionMarket` order book behaviour (⏳ pending founder sign-off, IMPLEMENTATION_NOTES §7.10).
- [x] **Flashloan work & Analysis** (BLUEPRINT §7.7)
  - ERC-3156 against pool-held assets, 0.05% fee; borrow full balance (⏳ "borrow all" deviation awaiting approval).
  - Verify: atomic repayment, fee credited to the pool, flash loan blocked / allowed per pool state; no reentrancy path into `settleBatch` or `repay`.
- [x] **Rollover bridge** (BLUEPRINT §3.7)
  - Borrower marks rollover before expiry with a top-up; order clears in next-expiry pool; up to 4 batches inside the window.
  - Measure: rollover success rate vs top-up size and next-pool depth; refund paths when the old window has already closed.
- [x] **Abandonment auction** (BLUEPRINT §3.5)
  - Forgotten borrowers; bidders escrow `K + premium`; close window ranks by premium with `MAX_BIDS` cap and segmented close.
  - Measure: residual value returned to R holders vs a naive default; bidder refunds via `pending`. ⏳ min bid increment and refund timing (BLUEPRINT §13.3).

### 2. Edge Cases
- [x] **Extreme condition settlement simulations** (BLUEPRINT §3.5, §4.1)
  - Price paths: −50% in one batch, flash crash and recovery inside the window, zero-volume weeks, one-sided books (§4.3).
  - Measure: default ratio by strike tier, lender realised return, circuit breaker behaviour (band ×1.5 per failed batch, pause after 3 failures, reset on new clearing price).
- [x] **Earn's hedging mechanism simulations** (BLUEPRINT §5)
  - Vault in a bear market: how much defaulted asset ends up in redemptions, NAV drawdown, the "sold put" explanation checked numerically; Pegged vault vs Low vs High strike vaults.
  - ❌ Confirm the rejected "APY ≥ X% auto-buyer" really is adversely selected (simulate it to show why it was rejected).
- [x] **Edge time simulations** (BLUEPRINT §3.5, ARCHITECTURE §2.9)
  - Block-based window: chain halt (no blocks for hours), `mature()` called late, `mature()` for a sibling pool starting the shared window, repay in the last block of the window, `closeWindow` racing a repay.
  - Guardian pause: 7-day renewals until expiry (⏳ cumulative cap, BLUEPRINT §13.5); verify cancel / repay / claim stay open while paused.
  - Grid edge: batch boundary exactly at expiry, order TTL expiring mid-window, `purge` of stale orders.
- [x] **Loop's edge cases** (BLUEPRINT §7.1)
  - LST depeg below 98% at expiry, partial repay of a multi-loop position, rollover of a looped position across two expiries, running out of quote mid-unwind.
- [x] **LP's edge cases**
  - Lender transfers C-Token mid-life, claims in the wrong order, claims twice, a receiving contract that reverts on token transfer (pull-refund guarantee, invariant #7); ERC-20 wrapper mint/burn round trips.
- [x] **Long-tail assets price discovery** (BLUEPRINT §4 "定期批次", §6)
  - 6 h / 24 h batches, minimum volume (流拍线), cancel deadline, first-auction bounds; issuer selling into a high strike pool.
  - Measure: batches to converge to a stable `P*`, sensitivity to a single large order, non-competitive share capped at 50% (⏳ "of total" vs "of competitive", IMPLEMENTATION_NOTES §7.1).
- [x] **Graduation** (BLUEPRINT §10)
  - Four consecutive cycles of zero pause / volume ≥ baseline / zero triple-fail; check a market that misses one cycle restarts the count. ⏳ wash-trading resistance (M-3).

### 3. Other Cases
- [x] **Maintainability**
  - Gas per entry point vs book depth (hint probing 3 nodes, `MAX_ORDERS_PER_SIDE`, `MAX_BIDS`); worst-case `settleBatch` / `closeWindow` gas under the per-batch cap; keeper cost per day per chain at Monad / HyperEVM / Sepolia block times.
- [x] **Security analysis** (adversarial actors, AUDIT M-1..M-3, ARCHITECTURE §2.11)
  - Wash trading to drag `vwap` toward `K` and zero out fees (⏳ M-2); front-running pool creation to pick a wide band tier (⏳ M-1); griefing the book with dust orders; bid spam at the window close; attempting to drain via the flash loan; reentrancy on every token callback; invariants #1–#7 fuzzed for thousands of random blocks.
- [x] **Feasibility**
  - Economic model: protocol revenue = spread share + flash fees + Harberger tax under several volume / default regimes; bootstrap market-maker budget to keep spreads tight for 8 weeks; seat holder P&L vs tax rate (BLUEPRINT §8, §9). ⏳ seat minimum obligation (§13.2).

### 4. Chaos Test
- [x] Random actor mix (borrowers, lenders, vaults, bidders, loopers, attackers) over hundreds of expiries with random price paths, random keeper outages and random RPC-free advancement; the run passes only if every §2.11 invariant holds at every block and no funds are stranded outside `pending` / claimable balances.

## Planned layout

```
Simulation-Confluere/
├── crates/model/   # pure-Rust mechanism model, Rules::v07() (deployed) vs Rules::v08() (2026-10-23 decisions)
├── crates/evm/     # revm + Alloy harness around the compiled contracts (deploy, trade, settle, window)
├── crates/sim/     # scenario runner → out/*.csv (src/scenarios/, one file per topic)
├── artifacts/      # compiled Confluere bytecode (forge build output, commit in SOURCE.txt)
├── out/            # CSV traces produced by the scenarios (gitignored)
└── notebooks/      # Jupyter: make_notebooks.py generates 01–04, which read out/
```

## How to use

`python3 verify.py` rebuilds, reruns every scenario from a clean `out/`, renders the charts, executes the notebooks and checks 19 completion criteria; it writes `out/VERIFICATION.md` (last run: 19/19 pass) and exits non-zero on any failure. The one open mechanism decision is written up with all measured options in `DECISION_wash_and_default.md`.

```sh
cargo test                                  # model unit tests + revm smoke test on the real bytecode
cargo run --release -p confluere-sim -- all # writes out/*.csv: crosscheck, baseline, fee_wash, nc_pricing, vault_tier,
                                            #  graduation, grid, pause, revenue, earn, loop, flashloan, rollover,
                                            #  abandonment, edge, gas, chaos (or name one; `chaos 4` = seeds)
python3 notebooks/plots_stdlib.py           # 28 SVG charts into out/plots/ (stdlib only)
python3 notebooks/make_notebooks.py         # (re)generate the notebooks (stdlib-only cells)
python3 notebooks/run_stdlib.py             # execute them in place, no Jupyter needed
# with Jupyter installed you can also: jupyter nbconvert --execute --to notebook --inplace notebooks/*.ipynb
```

`artifacts/` holds the compiled Confluere contracts (`SOURCE.txt` records the commit); regenerate them from the Confluere repo with `forge build` when the contracts change.
__For visual interactive website you can go to [Confluere-Simulation](https://straw.confluere.xyz)(Haven't launched yet!)__
## Support
### Security && Contact 
For any kind security or general contact messages are welcome!Feel free to reach out to [hello@internuntius.dev](mailto:hello@internuntius.dev) for communication!
### Licence
No Licence.Do whatever you want.
