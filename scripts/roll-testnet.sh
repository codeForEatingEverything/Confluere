#!/usr/bin/env bash
# Opens the next expiry on a testnet deployed by scripts/deploy-testnet.sh.
# Usage: scripts/roll-testnet.sh monad|hyperevm [collect|fund|pools|seed|sync]
# A market graduates after four consecutive expiries that each reached the graduation volume, so each run opens the
# expiry exactly one period after the one the last run opened (EXPIRY for CreatePools), not merely the nearest one:
# four runs give four consecutive expiries however early they start. Up to four expiries may be listed ahead, so the
# runs can follow each other directly; a run that would be past that limit waits in the foreground until the expiry
# becomes listable (NO_WAIT=1 stops instead). A run that comes late (the next expiry is less than a quarter period
# plus two minutes away, or past) warns and lets CreatePools open the nearest expiry with a quarter period of headroom.
# That may still be the consecutive one (inside the two-minute margin) or a later one; the count printed after every
# run is computed from the expiry actually opened, and says whether the chain was kept or starts over.
# Each run:
#   1. collect: claims the seeder's C units in Closed pools from earlier runs and withdraws its pending balances
#      (the funds come back for the next seed; pools not Closed yet are retried on the next run),
#   2. fund: checks balances against one seed and stops before creating anything if they fall short,
#   3. pools: CreatePools on the next expiry with the real tokens recorded in deployments/<chain>.json .pools,
#   4. seed: a two-sided book in every new pool at the chain's seed units (scripts/lib/testnet.sh: SEED_UNIT_BPS,
#      LST_SEED_UNIT_BPS, EXTRA_SEED_UNIT_BPS; pools already seeded are skipped), then trade: TRADE_ROUNDS rounds of
#      small crossing trades, one batch apart,
#   5. sync: regenerates the SDK addresses and, on Monad, the CRE workflow config (pnpm sync-config: receiver, vaults
#      and every pool that is not Closed, so maturing and closing the earlier expiries stays in the CRE tick).
# The optional step starts from there (after a failure). RESUME=1 resumes only that first step's interrupted broadcast;
# a failed step prints the exact command. The keeper (or CRE) settles, matures and closes the pools; graduation is
# permissionless and the keeper calls it. Reads PRIVATE_KEY from contracts/.env. Pool ids of earlier runs and the
# consecutive-expiry count live in ${XDG_STATE_HOME:-~/.local/state}/confluere/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
set -a; . ./.env; set +a
. "$ROOT/scripts/lib/testnet.sh"
testnet_env "${1:-}" || { echo "usage: $0 monad|hyperevm [collect|fund|pools|seed|sync]"; exit 1; }
[ -f "$J" ] && [ -n "$(jget "$J" pools.native)" ] || { echo "no pools in deployments/$NAME.json: run scripts/deploy-testnet.sh $CHAIN first"; exit 1; }
FROM=${2:-collect}
steps=(collect fund pools seed trade sync)
started=0
for st in "${steps[@]}"; do [ "$st" = "$FROM" ] && started=1; done
[ $started = 1 ] || { echo "unknown step $FROM (collect | fund | pools | seed | trade | sync)"; exit 1; }

# The real tokens this deployment was opened with (deployments/<chain>.json .pools), not the defaults.
LST=$(jget "$J" pools.lst); NATIVE=$(jget "$J" pools.native); USDC=$(jget "$J" pools.usdc)
export LST NATIVE USDC
# The extra pair (CreatePools EXTRA_*) this deployment already opens (.pools.extraAsset), else the chain's default from
# scripts/lib/testnet.sh (HyperEVM: USDC/WHYPE; Monad: none), so a roll can add the pair to a running deployment.
XA=$(jget "$J" pools.extraAsset)
if [ -n "$XA" ]; then EXTRA_ASSET=$XA; EXTRA_QUOTE=$(jget "$J" pools.extraQuote); export EXTRA_ASSET EXTRA_QUOTE; fi
CORE=$(jget "$J" confluere)
SEED_ROUTER=$(jget "$J" router) # Seed.s.sol batches the orders through the Router (fewer transactions)
if [ -n "$SEED_ROUTER" ]; then export SEED_ROUTER; else unset SEED_ROUTER; fi

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/confluere"
mkdir -p "$STATE_DIR"
HIST="$STATE_DIR/roll-$NAME-$CORE.txt"   # pool ids to claim once they close
CHAINF="$STATE_DIR/roll-$NAME-$CORE.chain" # "<last expiry opened> <consecutive count>"
touch "$HIST"
[ -s "$CHAINF" ] || echo "$(jget "$J" pools.expiry) 1" > "$CHAINF" # the expiry deploy-testnet.sh opened counts as one
remember_pools() {
  local id
  for id in $(jget "$J" pools.poolIds); do grep -qx "$id" "$HIST" || echo "$id" >> "$HIST"; done
  tail -n 64 "$HIST" > "$HIST.tmp" && mv "$HIST.tmp" "$HIST" # eight expiries is plenty: claims are retried each run
}
remember_pools

# Sets EXPIRY to one period after the last expiry opened ($1), waiting until it is listable if needed; leaves it
# unset (CreatePools takes the nearest expiry) when that one is too close (within two minutes of the quarter-period
# bound CreatePools enforces) or past, and says so. Whether the chain broke is decided by count_chain afterwards. A resumed broadcast is not simulated again and needs no EXPIRY.
plan_expiry() {
  local prev=$1 plan verdict nxt wait
  unset EXPIRY
  [ -n "$prev" ] || return 0
  [ "${RESUME:-0}" != 1 ] || return 0 # a resumed broadcast is not simulated again
  plan=$(python3 - "$prev" "$(rcast call "$CORE" "grid()((uint64,uint64,uint64,uint32,uint8))" --rpc-url "$R")" \
    "$(rcast block latest -f timestamp --rpc-url "$R")" <<'PY'
import re, sys
prev, now = int(sys.argv[1]), int(sys.argv[3])
anchor, period, _, max_exp, _ = [int(x) for x in re.sub(r"\[[^\]]*\]", "", sys.argv[2]).strip("() \n").split(",")]
nxt = prev + period
lead = nxt - now
# CreatePools checks lead >= period/4 again while simulating, up to three tries later: keep a margin for that
if lead < period // 4 + 120:
    print("late", nxt, 0)
elif lead > period * max_exp:
    print("wait", nxt, lead - period * max_exp, period)
else:
    print("ok", nxt, 0)
PY
  )
  read -r verdict nxt wait _ <<<"$plan"
  case $verdict in
    ok) export EXPIRY=$nxt ;;
    wait)
      if [ "${NO_WAIT:-0}" = 1 ] || [ "$wait" -gt "$(jget "$J" gridPeriod)" ]; then
        echo "STOP: expiry $nxt is not listable for another ${wait}s (four expiries are listed ahead already)."
        echo "Run again later; nothing was created."
        exit 1
      fi
      echo "  waiting ${wait}s until expiry $nxt is listable (Ctrl-C stops; nothing was created yet)"
      sleep "$((wait + 5))"
      export EXPIRY=$nxt
      ;;
    late)
      echo "  WARNING: late roll. $nxt (one period after the last roll's $prev) is within two minutes of the"
      echo "  quarter-period bound or past, so it is not forced; CreatePools opens the nearest expiry with a quarter"
      echo "  period of headroom. If that is not $nxt the consecutive count starts over (see the count below)."
      ;;
  esac
}

# After CreatePools: counts consecutive expiries this deployment opened.
count_chain() {
  local new last=0 count=0 period
  new=$(jget "$J" pools.expiry); period=$(jget "$J" gridPeriod)
  if [ -s "$CHAINF" ]; then read -r last count < "$CHAINF"; fi
  if [ "$new" = "$last" ]; then :
  elif [ "$last" != 0 ] && [ "$new" = $((last + period)) ]; then count=$((count + 1))
  else
    [ "$last" = 0 ] || echo "  expiry chain broken: $new is not one period after the last roll's $last; the count starts over"
    count=1
  fi
  echo "$new $count" > "$CHAINF"
  echo "  expiry $new: $count consecutive expiries opened (a market graduates after 4, each seeded and cleared)"
}

started=0
for st in "${steps[@]}"; do
  [ "$st" = "$FROM" ] && started=1
  [ $started = 1 ] || continue
  STEP=$st # for the RESUME hint
  case $st in
    collect)
      CLAIM_POOLS=$(paste -s -d , "$HIST") run "collect: claim closed pools, withdraw pending" script/Seed.s.sol 0 \
        --sig "collect()" ;;
    fund) echo; echo "== fund (balances for one seed)"; preflight ;;
    pools)
      plan_expiry "$(jget "$J" pools.expiry)"
      run "create pools (expiry ${EXPIRY:-nearest})" script/CreatePools.s.sol 1
      unset EXPIRY
      remember_pools
      count_chain ;;
    seed) run "seed two-sided books" script/Seed.s.sol 0 ;;
    trade) trade_rounds ;;
    sync) sync_offchain ;;
  esac
  unset RESUME # only the first step resumes
  [ "${UNTIL:-}" != "$st" ] || break # UNTIL=<step> stops after that step (UNTIL=collect: recover funds only)
done
echo; echo "rolled: deployments/$NAME.json now lists expiry $(jget "$J" pools.expiry)"
