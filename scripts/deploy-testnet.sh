#!/usr/bin/env bash
# Testnet deployment on real tokens (no mocks). Usage: scripts/deploy-testnet.sh monad|hyperevm [step]
# Reads PRIVATE_KEY from contracts/.env. Steps run in order: deploy fund pools seed vaults; the optional second argument
# starts from that step. Every step can be repeated: Deploy reuses CREATE2 contracts that already have code,
# CreatePools keeps existing pools, Seed skips pools the deployer already seeded this batch, CreateVaults reuses its
# vaults, and deployments/<chain>.json is replaced only after a step's broadcast landed. RESUME=1 finishes the
# interrupted broadcast of the first step run, and only that step's own (e.g. RESUME=1 scripts/deploy-testnet.sh
# hyperevm pools); a failed step prints the exact command. A failed Deploy attempt's staged file is kept for the re-run,
# so the log-scan start block stays the core's; without it Deploy asks for DEPLOY_BLOCK (the core's creation block).
# fund: checks the balances one seed needs and stops before any pool exists if they fall short (FUND=1 wraps the
# missing wrapped native). Later expiries: scripts/roll-testnet.sh (four consecutive expiries let a market graduate).
# Daily grid (GRID=daily: daily expiries listed 15 days ahead, 2 min batches, production ~2 h windows): the pools step
# opens 1-, 7- and 14-day maturities at once (MATURITY_DAYS, launch_expiries in scripts/lib/testnet.sh), one strike x
# both repay styles per pair; seed leaves a two-sided book in every pool and trade runs TRADE_ROUNDS small crossing
# rounds so every pool has fills and a price. UNTIL=<step> stops after that step.
# Chain parameters and the real token addresses live in scripts/lib/testnet.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"
set -a; . ./.env; set +a
. "$ROOT/scripts/lib/testnet.sh"
testnet_env "${1:-}" || { echo "usage: $0 monad|hyperevm [deploy|fund|pools|seed|vaults]"; exit 1; }
ME=$(cast wallet address "${SIGNER[@]}")

# Graduation rows of both testnets (USDC 1000 = 0.001 USDC, native 1e17 per expiry): see testnet_grad in
# scripts/lib/testnet.sh. They are part of the core's init code: changing them and redeploying gives a NEW core
# address on both chains (redeploy both; this script regenerates the SDK and CRE configs at the end).
testnet_grad
# The grid must be explicit: Deploy.s.sol defaults to the production grid and refuses demo / daily / mocks off testnets.
export TREASURY=$ME GUARDIAN=$ME DEMO=false GRID=daily MOCKS=false SALT=${SALT:-$TESTNET_SALT}

FROM=${2:-deploy}
steps=(deploy fund pools seed trade vaults); started=0
for st in "${steps[@]}"; do [ "$st" = "$FROM" ] && started=1; done
[ $started = 1 ] || { echo "unknown step $FROM (deploy | fund | pools | seed | trade | vaults)"; exit 1; }
started=0
for st in "${steps[@]}"; do
  [ "$st" = "$FROM" ] && started=1
  [ $started = 1 ] || continue
  STEP=$st # for the RESUME hint
  if [ "$st" = fund ] || [ "$st" = pools ]; then [ -n "${EXPIRY:-}" ] || launch_expiries; fi
  if [ "$st" != deploy ]; then SEED_ROUTER=$(jget "$J" router); if [ -n "$SEED_ROUTER" ]; then export SEED_ROUTER; else unset SEED_ROUTER; fi; fi
  case $st in
    deploy) bigblocks on; run "deploy core + periphery" script/Deploy.s.sol 1; bigblocks off ;;
    fund) echo; echo "== fund (balances for one seed)"; preflight ;;
    pools) run "create pools" script/CreatePools.s.sol 1 ;;
    seed) run "seed two-sided books" script/Seed.s.sol 0 ;;
    trade) trade_rounds ;;
    vaults) bigblocks on; run "vaults" script/CreateVaults.s.sol 1; bigblocks off ;;
  esac
  unset RESUME # only the first step resumes
  [ "${UNTIL:-}" != "$st" ] || break
done
sync_offchain
echo; echo "done: deployments/$NAME.json; SDK and CRE config regenerated"
