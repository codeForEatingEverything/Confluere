"""Render the key charts as SVG with the Python standard library only (no pandas / matplotlib needed).
Run: python3 notebooks/plots_stdlib.py  → out/plots/*.svg (the notebooks embed them)."""
import csv, math, pathlib
from collections import defaultdict

OUT = pathlib.Path(__file__).resolve().parent.parent / "out"
PLOTS = OUT / "plots"
PLOTS.mkdir(exist_ok=True)
COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#4b5563", "#be185d"]


def rd(name):
    with open(OUT / f"{name}.csv") as f:
        return list(csv.DictReader(f))


def fnum(x):
    try:
        v = float(x)
        return None if math.isnan(v) else v
    except (TypeError, ValueError):
        return None


def svg_chart(path, series, title, xlabel, ylabel, kind="line", w=760, h=400, logx=False):
    """series: list of (label, [(x, y), ...])."""
    esc = lambda t: str(t).replace("&", "&amp;").replace("<", "&lt;")
    title, xlabel, ylabel = esc(title), esc(xlabel), esc(ylabel)
    series = [(esc(lbl), pts_) for lbl, pts_ in series]
    pl, pr, pt, pb = 70, 20, 40, 60
    pts = [(x, y) for _, s in series for x, y in s if x is not None and y is not None]
    if not pts:
        return
    ys = [p[1] for p in pts]
    xs = [p[0] for p in pts] if kind != "bar" else [0.0, 1.0]
    if logx:
        xs = [math.log10(x) for x in xs if x > 0]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys + [0]), max(ys + [0])
    if xmax == xmin:
        xmax = xmin + 1
    if ymax == ymin:
        ymax = ymin + 1
    pad = (ymax - ymin) * 0.08
    ymin -= pad
    ymax += pad

    def X(x):
        if logx:
            x = math.log10(x)
        return pl + (x - xmin) / (xmax - xmin) * (w - pl - pr)

    def Y(y):
        return pt + (ymax - y) / (ymax - ymin) * (h - pt - pb)

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" font-family="Helvetica, Arial, sans-serif" font-size="12">',
           f'<rect width="{w}" height="{h}" fill="white"/>',
           f'<text x="{w/2}" y="22" text-anchor="middle" font-size="15" font-weight="bold">{title}</text>']
    # axes + grid
    for i in range(6):
        yv = ymin + (ymax - ymin) * i / 5
        out.append(f'<line x1="{pl}" y1="{Y(yv):.1f}" x2="{w-pr}" y2="{Y(yv):.1f}" stroke="#e5e7eb"/>')
        out.append(f'<text x="{pl-6}" y="{Y(yv)+4:.1f}" text-anchor="end" fill="#374151">{yv:,.4g}</text>')
    for i in range(6 if kind != "bar" else 0):
        xv = xmin + (xmax - xmin) * i / 5
        xx = pl + (xv - xmin) / (xmax - xmin) * (w - pl - pr)
        lab = 10 ** xv if logx else xv
        out.append(f'<text x="{xx:.1f}" y="{h-pb+18}" text-anchor="middle" fill="#374151">{lab:,.4g}</text>')
    out.append(f'<line x1="{pl}" y1="{Y(0):.1f}" x2="{w-pr}" y2="{Y(0):.1f}" stroke="#9ca3af"/>')
    out.append(f'<line x1="{pl}" y1="{pt}" x2="{pl}" y2="{h-pb}" stroke="#9ca3af"/>')
    out.append(f'<text x="{w/2}" y="{h-12}" text-anchor="middle" fill="#111827">{xlabel}</text>')
    out.append(f'<text transform="translate(16,{h/2}) rotate(-90)" text-anchor="middle" fill="#111827">{ylabel}</text>')
    n = len(series)
    for si, (label, s) in enumerate(series):
        c = COLORS[si % len(COLORS)]
        s = [(x, y) for x, y in s if x is not None and y is not None]
        if kind == "line":
            d = " ".join(f"{'M' if i == 0 else 'L'}{X(x):.1f},{Y(y):.1f}" for i, (x, y) in enumerate(s))
            out.append(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="2"/>')
            for x, y in s:
                out.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="2.5" fill="{c}"/>')
        elif kind == "scatter":
            for x, y in s:
                out.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="2" fill="{c}" fill-opacity="0.6"/>')
        elif kind == "bar":
            bw = (w - pl - pr) / (len(s) * (n + 1) + 1)
            for i, (x, y) in enumerate(s):
                x0 = pl + bw * (i * (n + 1) + si + 1)
                y0, y1 = Y(max(y, 0)), Y(min(y, 0))
                out.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{bw:.1f}" height="{max(y1-y0,1):.1f}" fill="{c}"/>')
                if si == 0:
                    out.append(f'<text x="{x0 + bw*n/2:.1f}" y="{h-pb+18}" text-anchor="middle" fill="#374151">{x}</text>')
        out.append(f'<rect x="{pl+10+si*150}" y="{pt-8}" width="12" height="12" fill="{c}"/>')
        out.append(f'<text x="{pl+26+si*150}" y="{pt+2}" fill="#111827">{label}</text>')
    out.append("</svg>")
    (PLOTS / path).write_text("\n".join(out))
    print("plot", path)


def by(rows, key):
    d = defaultdict(list)
    for r in rows:
        d[r[key]].append(r)
    return d


# 1. baseline: P* and implied APR, seed 0
b = [r for r in rd("baseline_batches") if r["seed"] == "0" and r["traded"] == "true"]
svg_chart("baseline_price.svg", [(k, [(fnum(r["batch"]), fnum(r["price"])) for r in v]) for k, v in by(b, "rules").items()] + [("reference", [(fnum(r["batch"]), fnum(r["ref_price"])) for r in rd("baseline_batches") if r["seed"] == "0" and r["rules"] == "v07"])],
          "Baseline: clearing price per batch (seed 0)", "batch (30 min)", "USDC per ETH")
svg_chart("baseline_apr.svg", [(k, [(fnum(r["batch"]), fnum(r["implied_apr"]) * 100) for r in v]) for k, v in by(b, "rules").items()], "Baseline: implied borrow APR", "batch", "APR %", kind="scatter")
s = rd("baseline_summary")
svg_chart("baseline_treasury.svg", [(k, [(r["seed"], fnum(r["treasury_fees"])) for r in v]) for k, v in by(s, "rules").items()], "Treasury fees per run (8 seeds)", "seed", "USDC", kind="bar")

# 2. crosscheck gas
cc = rd("crosscheck")
svg_chart("crosscheck_gas.svg", [("settleBatch", [(fnum(r["orders"]), fnum(r["evm_settle_gas"])) for r in cc])], "revm: settleBatch gas vs orders in the batch", "orders placed", "gas", kind="scatter")

# 3. nc pricing
n = rd("nc_pricing")
for book in ["ladder", "thin_supply", "deep_supply"]:
    svg_chart(f"nc_pricing_{book}.svg", [(k, [(fnum(r["nc_budget_usdc"]) / 1000, fnum(r["implied_apr"]) * 100) for r in v if r["book"] == book]) for k, v in by(n, "rules").items()], f"NC budget vs implied APR ({book})", "NC budget (k USDC)", "APR %")
svg_chart("nc_pricing_displacement.svg", [(k, [(fnum(r["nc_budget_usdc"]) / 1000, fnum(r["competitive_units"])) for r in v if r["book"] == "ladder"]) for k, v in by(n, "rules").items()], "Competitive units filled vs NC budget (ladder)", "NC budget (k USDC)", "ETH")
cap = rd("nc_cap_sweep")
svg_chart("nc_cap_sweep.svg", [(f"cap {int(k)/100:.0f}%", [(fnum(r["nc_budget_usdc"]) / 1000, fnum(r["implied_apr"]) * 100) for r in v]) for k, v in by(cap, "nc_cap_bps").items()], "NC share cap: implied APR vs budget", "NC budget (k USDC)", "APR %")

# 4. fee wash + dilution
w = rd("fee_wash")
svg_chart("fee_wash_fee.svg", [(k, [(fnum(r["wash_multiple"]), fnum(r["protocol_fee_total"])) for r in v]) for k, v in by(w, "rules").items()], "Protocol fee vs wash size (honest = 100 ETH)", "wash / honest volume", "USDC")
svg_chart("fee_wash_pnl.svg", [(f"attacker {k}", [(fnum(r["wash_multiple"]), fnum(r["attacker_pnl_usdc"])) for r in v]) for k, v in by(w, "rules").items()] + [(f"honest lender {k}", [(fnum(r["wash_multiple"]), fnum(r["honest_lender_pnl_usdc"])) for r in v]) for k, v in by(w, "rules").items()], "Wash-and-default P&L", "wash / honest volume", "USDC")
d = rd("dilution_variants")
svg_chart("dilution_variants.svg", [(k, [(fnum(r["wash_multiple"]), fnum(r["attacker_pnl_usdc"])) for r in v]) for k, v in by(d, "variant").items()], "Attacker P&L under the dilution-fix variants", "wash / honest volume", "USDC")

# 5. vault tier + graduation + revenue
v = rd("vault_tier")
svg_chart("vault_tier_cost.svg", [(k, [(r["attack"], fnum(r["attacker_fee_cost_usdc"])) for r in rows]) for k, rows in by(v, "rules").items()], "Attacker fee cost per vault-tier attack", "attack", "USDC", kind="bar")
g = [r for r in rd("graduation") if r["honest_apr"] == "0.05"]
svg_chart("graduation_cost.svg", [(k, [(fnum(r["honest_weekly_volume_usdc"]) / 1000, fnum(r["attacker_cost_4_expiries_usdc"])) for r in rows]) for k, rows in by(g, "rules").items()], "Cost to graduate by wash (4 expiries, 5% APR)", "honest weekly volume (k USDC)", "USDC")
rv = [r for r in rd("revenue") if r["apr"] == "0.05" and r["default_ratio"] == "0.0"]
svg_chart("revenue.svg", [(k, [(fnum(r["weekly_volume_usdc"]), fnum(r["treasury_weekly_usdc"])) for r in rows]) for k, rows in by(rv, "rules").items()], "Weekly treasury revenue (5% APR, no defaults)", "weekly volume (USDC)", "USDC / week", logx=True)

# 6. grid + pause
gr = rd("grid")
usd = [r for r in gr if fnum(r["price_usdc"]) > 50]
svg_chart("grid_steps.svg", [("2 sig digits (v0.7)", [(fnum(r["price_usdc"]), fnum(r["sig2_step_bps"])) for r in usd]), ("1% log grid (v0.8)", [(fnum(r["price_usdc"]), fnum(r["log_step_bps"])) for r in usd])], "Strike grid step size", "price (USDC, log)", "step (bps)", logx=True)
p = rd("pause")
svg_chart("pause.svg", [(k, [(fnum(r["block"]) / 86400, fnum(r["paused_total_blocks"]) / 86400) for r in rows]) for k, rows in by(p, "rules").items()], "Cumulative paused days vs time (guardian renews forever)", "days", "paused days")

# 7. earn
e = rd("earn")
for tier in ["low", "high"]:
    svg_chart(f"earn_nav_{tier}.svg", [(f"{r0['rules']} {r0['path']}" + (" guard" if r0["guard"] == "true" else ""), [(fnum(r["expiry_index"]), fnum(r["nav_per_share"])) for r in rows]) for (k, rows) in by([r for r in e if r["tier"] == tier], "rules").items() for r0 in [rows[0]] for _ in [0]] if False else
              [(f"{k}", [(fnum(r["expiry_index"]), fnum(r["nav_per_share"])) for r in rows]) for k, rows in by([dict(r, key=f"{r['rules']} {r['path']}" + (" guard" if r["guard"] == "true" else "")) for r in e if r["tier"] == tier], "key").items()],
              f"Vault NAV per share ({tier} tier)", "expiry index", "NAV")
tb = rd("earn_threshold_buyer")
svg_chart("earn_threshold_buyer.svg", [(k, [(fnum(r["apr_threshold"]), fnum(r["pnl_usdc"])) for r in rows]) for k, rows in by(tb, "path").items()], "❌ APY-threshold buyer: P&L by price path", "APR threshold", "USDC")

# 8. loop
lp = [r for r in rd("loop") if r["lender_depth_lst"] == "500.0"]
svg_chart("loop_leverage.svg", [(k, [(fnum(r["loops"]), fnum(r["leverage"])) for r in rows]) for k, rows in by(lp, "rules").items()], "Looping: leverage vs loop count (K 0.98, sell at 0.97)", "loops", "x")
svg_chart("loop_cost.svg", [(f"discount cost {k}", [(fnum(r["loops"]), fnum(r["discount_cost_native"])) for r in rows]) for k, rows in by(lp, "rules").items()] + [(f"fees {k}", [(fnum(r["loops"]), fnum(r["fees_paid_native"])) for r in rows]) for k, rows in by(lp, "rules").items()], "Looping: interest and fees (native) for 100 LST", "loops", "native")

# 9. abandonment
ab = [r for r in rd("abandonment") if r["rules"] == "v08"]
svg_chart("abandonment_recovery.svg", [(f"{k} bidders", [(fnum(r["market_price"]), fnum(r["premium_to_r_holders_usdc"])) for r in rows]) for k, rows in by(ab, "bidders").items()], "Abandonment auction: premium returned to forgetful R holders (10 ETH, K 3400)", "market price at expiry", "USDC")

# 10. gas
ga = rd("gas")
svg_chart("gas_settle.svg", [("settleBatch", [(fnum(r["n"]), fnum(r["gas"])) for r in ga if r["op"] == "settleBatch"])], "settleBatch gas vs orders in the book (revm)", "orders", "gas")
svg_chart("gas_close.svg", [("closeWindow", [(fnum(r["n"]), fnum(r["gas"])) for r in ga if r["op"] == "closeWindow"])], "closeWindow gas vs bids (revm)", "bids", "gas")

# 11. extreme
ex = [r for r in rd("edge_extreme") if r["rules"] == "v08"]
svg_chart("extreme_band_failures.svg", [(k, [(fnum(r["batch"]), fnum(r["band_failures"])) for r in rows]) for k, rows in by(ex, "path").items()], "Band failures per batch under extreme paths (v0.8)", "batch", "consecutive failures")
svg_chart("extreme_nc_units.svg", [(k, [(fnum(r["batch"]), fnum(r["nc_units"])) for r in rows]) for k, rows in by(ex, "path").items()], "NC units filled per batch under extreme paths (v0.8)", "batch", "ETH")

# 12. chaos
ch = rd("chaos")
svg_chart("chaos.svg", [("invariant checks", [(f"{r['rules']}-{r['seed']}", fnum(r["invariant_checks"])) for r in ch]), ("violations", [(f"{r['rules']}-{r['seed']}", fnum(r["invariant_violations"])) for r in ch])], "Chaos runs: invariant checks vs violations", "run", "count", kind="bar")
print("done")
