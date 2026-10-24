"""Generate the analysis notebooks. Every code cell uses the standard library only (csv + the pre-rendered
SVG charts), so `run_stdlib.py` can execute them on a machine without pandas / Jupyter; with pandas installed the
same `load()` returns rows you can wrap in a DataFrame (`pd.DataFrame(load("x"))`).

Run: python3 notebooks/make_notebooks.py && python3 notebooks/run_stdlib.py
"""
import json, pathlib

HERE = pathlib.Path(__file__).parent

PRELUDE = '''import csv
from pathlib import Path
OUT = Path("../out")

def load(name):
    """rows of out/<name>.csv as dicts (numbers stay strings; use f())"""
    with open(OUT / f"{name}.csv") as fh:
        return list(csv.DictReader(fh))

def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return x

def show(rows, cols=None, limit=40, where=None):
    """print rows as an aligned table"""
    if where:
        rows = [r for r in rows if where(r)]
    rows = rows[:limit]
    if not rows:
        print("(no rows)"); return
    cols = cols or list(rows[0].keys())
    def fmt(v):
        try:
            x = float(v)
            return f"{x:,.4g}" if abs(x) < 1e6 else f"{x:,.0f}"
        except (TypeError, ValueError):
            return str(v)
    cells = [[fmt(r.get(c, "")) for c in cols] for r in rows]
    w = [max(len(c), *(len(row[i]) for row in cells)) for i, c in enumerate(cols)]
    print(" | ".join(c.ljust(w[i]) for i, c in enumerate(cols)))
    print("-+-".join("-" * x for x in w))
    for row in cells:
        print(" | ".join(v.rjust(w[i]) for i, v in enumerate(row)))

def svg(name):
    """display a pre-rendered chart from out/plots"""
    p = OUT / "plots" / name
    try:
        from IPython.display import SVG, display
        display(SVG(filename=str(p)))
    except Exception:
        print(f"[chart: {p}]")
'''


def nb(cells):
    return {
        "cells": [
            {"cell_type": c[0], "metadata": {}, "source": c[1].strip("\n"), **({"outputs": [], "execution_count": None} if c[0] == "code" else {})}
            for c in cells
        ],
        "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}, "language_info": {"name": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def chart(name, caption):
    return ("code", f'svg("{name}")  # {caption}')


NOTEBOOKS = {
    "01_basic_borrow_lend.ipynb": [
        ("markdown", "# 1. Basic borrow / lend\nModel vs. contracts cross-check, then a 7-day pool under v0.7 (deployed) and v0.8 (2026-10-23 decisions) rules with the same random seed."),
        ("code", PRELUDE),
        ("markdown", "## Cross-check: Rust model against the compiled contracts in revm\nEvery random batch must agree on P*, filled units and every account's R / C / pending balances."),
        ("code", '''cc = load("crosscheck")
print("batches:", len(cc), " price mismatches:", sum(r["price_match"] != "true" for r in cc), " payout mismatches:", sum(r["payouts_match"] != "true" for r in cc))
gas = sorted(f(r["evm_settle_gas"]) for r in cc); print("settleBatch gas min/median/max:", gas[0], gas[len(gas)//2], gas[-1])'''),
        chart("crosscheck_gas.svg", "settleBatch gas vs orders"),
        ("markdown", "## Baseline lifecycle"),
        chart("baseline_price.svg", "clearing price per batch, seed 0"),
        chart("baseline_apr.svg", "implied borrow APR"),
        chart("baseline_treasury.svg", "treasury fees per run"),
        ("code", '''show(load("baseline_summary"), ["rules","seed","final_ref_price","total_units","default_ratio","treasury_fees","c_holder_quote","c_holder_asset","lender_return_on_quote_paid"])'''),
        ("markdown", "Under v0.7 a fully defaulted pool pays the treasury nothing; under v0.8 the 0.03 % trade fee was collected at clearing. When borrowers repay, v0.7's 10 % of interest exceeds v0.8's 5 % + 0.03 %."),
    ],
    "02_pricing_and_fees.ipynb": [
        ("markdown", "# 2. Non-competitive demand in pricing, wash trading, revenue\nBLUEPRINT §4.2 and §8 (2026-10-23)."),
        ("code", PRELUDE),
        ("markdown", "## Non-competitive buy budget vs. P*\nUnder v0.7 the retail budget never trades when the competitive book crosses exactly (no leftovers). Under v0.8 it enters the demand curve, capped at 50 % of the competitive volume, and lifts P* (lowers the borrow rate) while displacing competitive lenders."),
        chart("nc_pricing_ladder.svg", "ladder book"),
        chart("nc_pricing_thin_supply.svg", "thin supply"),
        chart("nc_pricing_deep_supply.svg", "deep supply"),
        chart("nc_pricing_displacement.svg", "competitive units displaced"),
        ("code", '''show(load("nc_pricing"), ["rules","book","nc_budget_usdc","price","implied_apr","competitive_units","nc_units_in_pricing","nc_units_filled","nc_budget_unfilled_pct"], where=lambda r: r["book"] == "ladder")'''),
        ("markdown", "### NC share cap sweep (25 / 33 / 50 %)"),
        chart("nc_cap_sweep.svg", "cap sweep"),
        ("code", '''show(load("nc_cap_sweep"))'''),
        ("markdown", "## Wash trading (AUDIT M-2) and the dilution attack it exposes\nAn attacker self-trades at K − 1 and **defaults** (holding both R and C, the asset comes straight back). Under v0.7 the pool VWAP is pulled to K and the honest borrower's fee collapses. Under v0.8 the honest borrower's fee is untouched and the protocol earns the trade fee. **But in both versions the attacker profits**: the defaulted units share the honest borrower's repaid K pro rata."),
        chart("fee_wash_fee.svg", "protocol fee vs wash size"),
        chart("fee_wash_pnl.svg", "wash-and-default P&L"),
        ("code", '''show(load("fee_wash"), ["rules","wash_multiple","vwap","protocol_fee_total","fee_lost_pct","attacker_pnl_usdc","honest_lender_pnl_usdc"])'''),
        ("markdown", "### Dilution-fix variants\nA = per-batch C (each batch its own tranche); B = the band applied to competitive clearing."),
        chart("dilution_variants.svg", "attacker P&L under the variants"),
        ("code", '''show(load("dilution_variants"))'''),
        ("markdown", "## Revenue magnitudes (closed form, BLUEPRINT §8)"),
        chart("revenue.svg", "weekly treasury revenue"),
        ("code", '''show(load("revenue"), ["rules","weekly_volume_usdc","apr","default_ratio","spread_share_usdc","trade_fee_usdc","treasury_weekly_usdc","treasury_yearly_usdc"], where=lambda r: r["apr"] == "0.05")'''),
    ],
    "03_vault_tier_and_graduation.ipynb": [
        ("markdown", "# 3. Vault strike selection, graduation, seats\nBLUEPRINT §5, §9 and §10 (2026-10-23)."),
        ("code", PRELUDE),
        ("markdown", "## Which strike does each vault pick?\nHonest market: five strikes over three expiries, 3400 is the main tier (400 k USDC per expiry). The attacker opens K = 6800 (or 1000) and wash-trades. v0.7 is hijacked by a 20 USDC wash; v0.8 ignores it, but out-volume-ing the main tier flips both vaults for ~0.03 % of the wash notional per expiry. develop's guard (protective limit and candidates from the previous VWAP) closes that path; see notebook 5."),
        chart("vault_tier_cost.svg", "attacker cost per attack"),
        ("code", '''show(load("vault_tier"))'''),
        ("markdown", "## Graduation: volume (v0.7) vs fees paid (v0.8)"),
        chart("graduation_cost.svg", "cost to graduate by wash"),
        ("code", '''show(load("graduation"), where=lambda r: r["honest_apr"] == "0.05")'''),
        ("markdown", "## Seat economics (BLUEPRINT §9) and bootstrap market maker\nSeat income = 70 % / 35 % of the market's treasury revenue; Harberger tax 15 %/yr; the obligation ties up ~half a week of 10 %-of-batch bids. A seat is viable when someone would pay ≥ 1,000 USDC for it at a 12 % required return."),
        ("code", '''show(load("seats"), ["weekly_volume_usdc","apr","graduated","seat_income_yearly_usdc","obligation_capital_usdc","breakeven_seat_price_usdc","seat_price_at_12pct_required_return_usdc","viable"], where=lambda r: r["apr"] == "0.05")'''),
        ("code", '''show(load("bootstrap_mm"))'''),
    ],
    "04_grid_and_pause.ipynb": [
        ("markdown", "# 4. Strike grid and Guardian pause cap\nBLUEPRINT §3.3 and §10 (2026-10-23)."),
        ("code", PRELUDE),
        chart("grid_steps.svg", "strike grid step size"),
        ("code", '''show(load("grid"), limit=20, where=lambda r: f(r["price_usdc"]) > 1000)'''),
        ("markdown", "The 2-digit grid steps between 1 % and 10 % and jumps to 10 % exactly where LST ratios cross 1.0; the log grid is 1 % everywhere."),
        chart("pause.svg", "cumulative paused days under renewals"),
        ("code", '''p = load("pause"); show([r for r in p if r["block"] == "604800"])'''),
    ],
    "05_earn_loop_flash_rollover.ipynb": [
        ("markdown", "# 5. Earn vault, looping, flash loans, rollover, abandonment auction\nBLUEPRINT §5, §7.1, §7.7, §3.7, §3.5."),
        ("code", PRELUDE),
        ("markdown", "## Earn vault\nFour expiries of history graduate the market, then the vault invests for four expiries on bull / flat / bear paths. v0.7 vaults never fill when the competitive book crosses exactly (they only take leftovers); v0.8 vaults fill through the demand curve. The Low/main vault sits out whenever the market trades above K (a lender never pays P* ≥ K). `guard` = develop's protective-limit rule."),
        chart("earn_nav_low.svg", "Low / main tier vault NAV"),
        chart("earn_nav_high.svg", "High tier vault NAV"),
        ("code", '''show(load("earn"), ["rules","path","tier","guard","target_strike","nav_per_share","asset_for_sale_eth","asset_fallback_eth","redeem_queue_len","redeemed_total"], where=lambda r: r["expiry_index"] == "7")'''),
        ("markdown", "### ❌ APY-threshold buyer (adverse selection)\nThe threshold never binds in a bull market (nothing to buy below K) and always binds in a bear market: it buys the most exactly when the asset is falling."),
        chart("earn_threshold_buyer.svg", "threshold buyer P&L by path"),
        ("code", '''show(load("earn_threshold_buyer"))'''),
        ("markdown", "## Looping (kHYPE/HYPE-style, K = 0.98, sell at 0.97)"),
        chart("loop_leverage.svg", "leverage vs loop count"),
        chart("loop_cost.svg", "interest and fees per 100 LST"),
        ("code", '''show(load("loop"), ["rules","loops","lender_depth_lst","leverage","discount_cost_native","fees_paid_native","breakeven_rate_move_pct","outcome_if_default_native"], where=lambda r: r["lender_depth_lst"] == "500.0")'''),
        ("code", '''show(load("loop_edges"), ["rules","case","ok","detail"])'''),
        ("markdown", "## Flash loans (real bytecode in revm)"),
        ("code", '''show(load("flashloan"))'''),
        ("markdown", "## Rollover bridge\nv0.7 rollovers only fill inside the window; a 24 h pool has at most one batch boundary in a 2 h window, so most of them default. v0.8 lets the last pre-expiry batch fill them."),
        ("code", '''from collections import Counter
for (k, v) in sorted(Counter((r["rules"], r["cadence"], r["outcome"]) for r in load("rollover")).items()): print(k, v)'''),
        ("markdown", "## Abandonment auction"),
        chart("abandonment_recovery.svg", "premium returned to forgetful R holders"),
        ("code", '''show(load("abandonment"), where=lambda r: r["rules"] == "v08")'''),
    ],
    "06_edge_chaos_gas_security.ipynb": [
        ("markdown", "# 6. Edge cases, chaos, gas, security\nSection 2 edge cases as pass/fail checks, extreme price paths, the chaos run, gas and the security checks on the real bytecode."),
        ("code", PRELUDE),
        ("code", '''c = load("edge_checks"); print("failed:", sum(r["ok"] != "true" for r in c), "of", len(c)); show(c, ["group","rules","case","observed","ok"], limit=60)'''),
        chart("extreme_band_failures.svg", "band failures under extreme paths"),
        chart("extreme_nc_units.svg", "NC fills under extreme paths"),
        ("code", '''show(load("edge_extreme"), ["batch","ref_price","traded","price","nc_units","band_failures","breaker_tripped","no_trade_reason"], where=lambda r: r["rules"] == "v08" and r["path"] == "crash_50")'''),
        ("markdown", "## Chaos\nRandom actors, keeper outages, pauses, rollovers, bids and an attacker over 8 expiries × 4 strikes; every step checks ARCHITECTURE §2.11 #1/#2 and the asset = unrepaid R identity."),
        chart("chaos.svg", "invariant checks vs violations per run"),
        ("code", '''show(load("chaos"), ["rules","seed","pools","batches_settled","batches_skipped_keeper_down","orders_placed","rollovers","bids","pauses","invariant_checks","invariant_violations","stranded_quote_usdc","stranded_asset_eth"])'''),
        ("markdown", "## Gas (revm, real bytecode)"),
        chart("gas_settle.svg", "settleBatch gas vs orders"),
        chart("gas_close.svg", "closeWindow gas vs bids"),
        ("code", '''show(load("gas")); show(load("keeper_cost"))'''),
        ("markdown", "## Security checks (real bytecode)\nReentrancy through the flash-loan callback and through a hostile token, dust-order griefing at the 128-order cap, bid spam at MAX_BIDS; AUDIT M-1 (band tier chosen by the first creator) in the model."),
        ("code", '''s = load("security_checks"); print("failed:", sum(r["ok"] != "true" for r in s), "of", len(s)); show(s, ["group","case","observed","ok"])'''),
        ("code", '''show(load("security_m1_band"))'''),
    ],
}

for name, cells in NOTEBOOKS.items():
    (HERE / name).write_text(json.dumps(nb(cells), indent=1))
    print("wrote", name)
