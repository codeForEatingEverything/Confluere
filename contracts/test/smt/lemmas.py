"""
Machine-checked arithmetic lemmas behind the two properties Halmos cannot finish on EVM bit-vectors
(see docs/IMPLEMENTATION_NOTES.md). Each lemma is proved over unbounded mathematical integers with z3:
we assert the negation and require `unsat`.

The link to the deployed code: Solady's fullMulDiv / fullMulDivUp return exactly floor(x*y/d) / ceil(x*y/d)
whenever the result fits in 256 bits, which it always does here (operands are uint96/uint128, d >= 1).
testFuzz_soladyMatchesPlain checks that equality on the contract's own ranges.

Run: ~/.local/share/uv/tools/halmos/bin/python test/smt/lemmas.py
"""
import sys
from z3 import Ints, And, Implies, Not, Solver, unsat, sat

def prove(name, claim):
    s = Solver()
    s.set("timeout", 120_000)
    s.add(Not(claim))
    r = s.check()
    ok = r == unsat
    # Non-vacuity: the premises must be satisfiable, or any conclusion would "prove".
    premises = claim.arg(0)
    v = Solver()
    v.set("timeout", 120_000)
    v.add(premises)
    nonvacuous = v.check() == sat
    print(f"[{'PROVED' if ok and nonvacuous else 'FAILED'}] {name} ({r}; premises {'satisfiable' if nonvacuous else 'VACUOUS'})")
    return ok and nonvacuous

def floor_def(q, x, d):  # q = floor(x / d), d > 0
    return And(q * d <= x, x < (q + 1) * d)

def ceil_def(q, x, d):  # q = ceil(x / d), d > 0
    return And(q * d >= x, (q - 1) * d < x)

b, s, p, f, cost = Ints("b s p f cost")
u, K, v, phi, B, fee, pay = Ints("u K v phi B fee pay")

results = []

# A. Non-competitive buy: f = floor(b*s/p) units cost ceil(f*p/s) <= budget b.
results.append(prove(
    "ncBuyWithinBudget: ceil(floor(b*s/p)*p/s) <= b",
    Implies(
        And(b >= 0, s > 0, p > 0, floor_def(f, b * s, p), ceil_def(cost, f * p, s)),
        cost <= b,
    ),
))

# B. Spread share never exceeds repayment: floor(u*(K-v)*phi / (s*B)) <= ceil(u*K/s), phi <= B, v < K.
results.append(prove(
    "feeBounded: floor(u*(K-v)*phi/(s*B)) <= ceil(u*K/s)",
    Implies(
        And(u >= 0, K > 0, v >= 0, v < K, phi >= 0, B > 0, phi <= B, s > 0,
            floor_def(fee, u * (K - v) * phi, s * B), ceil_def(pay, u * K, s)),
        fee <= pay,
    ),
))

# C. Rounding favours the pool: ceil(x/d) - floor(x/d) is 0 or 1 (dust kept by the pool is at most 1 wei per fill).
x, d, lo, hi = Ints("x d lo hi")
results.append(prove(
    "rounding: 0 <= ceil(x/d) - floor(x/d) <= 1",
    Implies(And(x >= 0, d > 0, floor_def(lo, x, d), ceil_def(hi, x, d)), And(hi - lo >= 0, hi - lo <= 1)),
))

# D. Buy escrow reserve: escrow = ceil(r*L/S) + k covers any fill f <= r at P <= L, and the remainder r-f with k-1
#    batches left, i.e. e - ceil(f*P/S) >= ceil((r-f)*L/S) + (k-1). (ClearingLogic._fillBuy never underflows.)
r, L, P, S, k, e, c1, c2, c3 = Ints("r L P S k e c1 c2 c3")
results.append(prove(
    "buyEscrow: reserve survives every partial fill",
    Implies(
        And(r >= 0, f >= 0, f <= r, P >= 0, P <= L, S > 0, k >= 1,
            ceil_def(c1, r * L, S), e >= c1 + k,
            ceil_def(c2, f * P, S), ceil_def(c3, (r - f) * L, S)),
        e - c2 >= c3 + (k - 1),
    ),
))

# Mutation check: a deliberately wrong claim must NOT prove (guards against a broken harness).
s_ = Solver()
s_.add(Not(Implies(
    And(r >= 0, f >= 0, f <= r, P >= 0, P <= L, S > 0, k >= 1,
        ceil_def(c1, r * L, S), e >= c1 + k, ceil_def(c2, f * P, S), ceil_def(c3, (r - f) * L, S)),
    e - c2 >= c3 + k,  # wrong: one wei of reserve is consumed per batch
)))
mut_ok = s_.check() == sat
print(f"[{'OK' if mut_ok else 'FAILED'}] mutation (reserve not reduced per batch) is refuted with a counterexample")

sys.exit(0 if all(results) and mut_ok else 1)
