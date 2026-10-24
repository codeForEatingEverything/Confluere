# Verification report

Generated 2026-10-24T03:15:07 by `python3 verify.py` on a clean `out/`.

**Result: ALL PASS** (19/19)

| Check | Result | Detail |
|---|---|---|
| cargo test | pass | 13 tests, 2s |
| sim all exits 0 | pass | 2s |
| 28 CSV files written | pass | 28 |
| model vs contracts: 0 mismatches | pass | crosscheck: 180 batches, 0 mismatches |
| no scenario assertion fired | pass |  |
| crosscheck rows agree on price and payouts | pass | 180 batches |
| chaos: 0 invariant violations, 0 stranded funds | pass | 18 runs over ['v07', 'v08', 'v08_tranche'], 49500 checks |
| edge_checks: all pass | pass | 36 checks |
| security_checks: all pass | pass | 13 checks |
| loop_edges: all pass | pass | 8 checks |
| flash loan: full balance ok, over-balance and non-repay revert | pass |  |
| wash-and-default profitable under shared pot, unprofitable under tranche rule | pass | shared [3336, 5019, 6679, 8163], tranche [-51, -102, -204, -510] |
| v0.7 vault hijacked by tiny wash, v0.8 not | pass |  |
| v0.8 last-batch rule fills 24h-pool rollovers that default under v0.7 | pass |  |
| pause: v0.8 cumulative cap holds, v0.7 renews forever | pass |  |
| 28 SVG charts rendered | pass |  |
| notebooks executed without errors | pass | 6 notebooks, 60 code cells, 54 with output |
| README checklist fully ticked, no partial notes | pass | 17 items |
| README results table covers every CSV | pass |  |
