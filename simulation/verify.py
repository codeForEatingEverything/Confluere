#!/usr/bin/env python3
"""End-to-end verification: rebuild, run every scenario from a clean out/, render charts, execute notebooks,
then check every completion criterion and write out/VERIFICATION.md. Exit code 1 if anything fails.
Run: python3 verify.py            (≈ 10 minutes; `python3 verify.py --quick` skips the chaos seeds down to 2)"""
import csv, datetime, glob, json, pathlib, re, subprocess, sys, time

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "out"
quick = "--quick" in sys.argv
checks = []


def check(name, ok, detail=""):
    checks.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def sh(cmd, timeout=1800):
    t = time.time()
    r = subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout + r.stderr, time.time() - t


def rd(name):
    with open(OUT / f"{name}.csv") as f:
        return list(csv.DictReader(f))


# 1. build + unit tests (model + revm smoke on the real bytecode)
rc, out, dt = sh("cargo test --release 2>&1")
results = re.findall(r"test result: (\w+)\. (\d+) passed; (\d+) failed", out)
check("cargo test", rc == 0 and all(r[0] == "ok" for r in results), f"{sum(int(r[1]) for r in results)} tests, {dt:.0f}s")

# 2. clean scenario run
for f in OUT.glob("*.csv"):
    f.unlink()
rc, out, dt = sh("./target/release/sim all" + (" 2" if quick else ""), timeout=3600)
check("sim all exits 0", rc == 0, f"{dt:.0f}s")
written = len(re.findall(r"^wrote ", out, re.M))
check("28 CSV files written", written == 28 and len(glob.glob(str(OUT / "*.csv"))) == 28, f"{written}")
check("model vs contracts: 0 mismatches", "0 mismatches" in out, re.search(r"crosscheck: .*", out).group(0) if re.search(r"crosscheck: .*", out) else "missing")
check("no scenario assertion fired", "panicked" not in out and "FAILED" not in out)

# 3. result-level criteria
cc = rd("crosscheck")
check("crosscheck rows agree on price and payouts", all(r["price_match"] == "true" and r["payouts_match"] == "true" for r in cc), f"{len(cc)} batches")
ch = rd("chaos")
check("chaos: 0 invariant violations, 0 stranded funds", all(r["invariant_violations"] == "0" and float(r["stranded_quote_usdc"]) == 0 and float(r["stranded_asset_eth"]) == 0 for r in ch), f"{len(ch)} runs over {sorted(set(r['rules'] for r in ch))}, {sum(int(r['invariant_checks']) for r in ch)} checks")
for name in ["edge_checks", "security_checks", "loop_edges"]:
    rows = rd(name)
    check(f"{name}: all pass", all(r["ok"] == "true" for r in rows), f"{len(rows)} checks")
fl = rd("flashloan")
check("flash loan: full balance ok, over-balance and non-repay revert", {r["case"]: r["ok"] for r in fl}.items() >= {"full_balance_repaid": "true", "over_balance": "false", "full_balance_not_repaid": "false"}.items())
dv = rd("dilution_variants")
shared = [r for r in dv if r["variant"] == "v08_shared_pot"]
tr = [r for r in dv if r["variant"] == "A_tranche_rule"]
check("wash-and-default profitable under shared pot, unprofitable under tranche rule", all(float(r["attacker_pnl_usdc"]) > 1000 for r in shared) and all(float(r["attacker_pnl_usdc"]) < 0 for r in tr), f"shared {[round(float(r['attacker_pnl_usdc'])) for r in shared]}, tranche {[round(float(r['attacker_pnl_usdc'])) for r in tr]}")
vt = rd("vault_tier")
check("v0.7 vault hijacked by tiny wash, v0.8 not", any(r["rules"] == "v07" and r["attack"] == "tiny_high_strike" and r["high_vault_hijacked"] == "true" for r in vt) and all(not (r["rules"] == "v08" and r["attack"].startswith("tiny") and (r["high_vault_hijacked"] == "true" or r["low_vault_hijacked"] == "true")) for r in vt))
ro = rd("rollover")
check("v0.8 last-batch rule fills 24h-pool rollovers that default under v0.7", any(r["rules"] == "v07" and r["cadence"] == "2" and r["outcome"].startswith("defaulted") for r in ro) and not any(r["rules"] == "v08" and r["cadence"] == "2" and r["outcome"].startswith("defaulted") for r in ro))
pa = rd("pause")
last = {r["rules"]: r for r in pa if r["block"] == "604800"}
check("pause: v0.8 cumulative cap holds, v0.7 renews forever", int(last["v08"]["paused_total_blocks"]) <= 50_400 < int(last["v07"]["paused_total_blocks"]))

# 4. charts + notebooks
rc, out, dt = sh("python3 notebooks/plots_stdlib.py")
check("28 SVG charts rendered", rc == 0 and len(glob.glob(str(OUT / "plots/*.svg"))) == 28)
rc, out, dt = sh("cd notebooks && python3 make_notebooks.py && python3 run_stdlib.py")
nbs = sorted(glob.glob(str(ROOT / "notebooks/*.ipynb")))
code_cells = [c for f in nbs for c in json.load(open(f))["cells"] if c["cell_type"] == "code"]
errors = [o for c in code_cells for o in c["outputs"] if o.get("output_type") == "error"]
with_output = sum(1 for c in code_cells if c["outputs"])
check("notebooks executed without errors", rc == 0 and not errors, f"{len(nbs)} notebooks, {len(code_cells)} code cells, {with_output} with output")

# 5. README checklist
readme = (ROOT / "README.md").read_text()
items = re.findall(r"- \[(x| )\] \*\*(.+?)\*\*", readme)
check("README checklist fully ticked, no partial notes", items and all(i[0] == "x" for i in items) and "open)" not in readme, f"{len(items)} items")
check("README results table covers every CSV", all(f"`{pathlib.Path(p).name}`" in readme or pathlib.Path(p).stem.split("_")[0] in readme for p in glob.glob(str(OUT / "*.csv"))))

# report
ok = all(c[1] for c in checks)
lines = [f"# Verification report", "", f"Generated {datetime.datetime.now().isoformat(timespec='seconds')} by `python3 verify.py{' --quick' if quick else ''}` on a clean `out/`.", "", f"**Result: {'ALL PASS' if ok else 'FAILURES'}** ({sum(c[1] for c in checks)}/{len(checks)})", "", "| Check | Result | Detail |", "|---|---|---|"]
for n, o, d in checks:
    lines.append(f"| {n} | {'pass' if o else 'FAIL'} | {d} |")
(OUT / "VERIFICATION.md").write_text("\n".join(lines) + "\n")
print(f"\n{'ALL PASS' if ok else 'FAILURES'} — report: out/VERIFICATION.md")
sys.exit(0 if ok else 1)
