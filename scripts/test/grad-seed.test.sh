#!/usr/bin/env bash
# The testnet graduation rows (testnet_grad in scripts/lib/testnet.sh) must sit below the volume one small seed clears
# (SEED_UNIT_BPS, default 100 as in scripts/roll-testnet.sh), or the four rolled expiries never graduate a market.
# Runs ScriptChecks.gradCovered in forge's in-memory EVM with each testnet's GRAD row, tokens and strikes; no RPC,
# nothing is sent. Usage: bash scripts/test/grad-seed.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/scripts/lib/testnet.sh"
testnet_grad
trap 'rm -f "$ROOT/deployments/.grad-check.tmp"; testnet_cleanup' EXIT
cd "$ROOT/contracts"
for chain in monad hyperevm; do
  unset EXTRA_SEED_UNIT_BPS # each chain's own default (the previous iteration exported its value)
  testnet_params "$chain"
  unset FOUNDRY_GAS_LIMIT # HyperEVM broadcast setting; the in-memory check deploys the whole script contract
  # Monad's extra pair shMON/USDC is seeded small (the wallet holds little shMON) and no vault lends into it, so it
  # need not graduate; only HyperEVM's extra pair (the native-coin vault's market) is held to the graduation row
  [ "$chain" = monad ] && export EXTRA_ASSET=$ZERO
  id=10143; [ "$chain" = hyperevm ] && id=998
  out=$(SEED_UNIT_BPS=${SEED_UNIT_BPS:-100} forge script script/checks/ScriptChecks.s.sol --sig "gradCovered(uint256)" "$id" 2>&1) \
    || { echo "$out" | grep -E "Error|revert|below" | head -5; echo "FAIL: $chain: one seed does not clear GRAD_$id"; exit 1; }
  echo "$out" | grep -E "market volume|grad check OK" | sed "s/^/  $chain: /"
done
echo "grad-seed tests OK"
