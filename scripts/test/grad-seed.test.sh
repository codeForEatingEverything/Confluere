#!/usr/bin/env bash
# The testnet graduation rows (testnet_grad in scripts/lib/testnet.sh) must sit below the volume one seed and its trade
# rounds clear (the chain's SEED_UNIT_BPS and TRADE_ROUNDS from scripts/lib/testnet.sh), or the four rolled daily
# expiries never graduate the native/USDC market (the USD vaults' market).
# Runs ScriptChecks.gradCovered in forge's in-memory EVM with each testnet's GRAD row, tokens and strikes; no RPC,
# nothing is sent. Usage: bash scripts/test/grad-seed.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/scripts/lib/testnet.sh"
testnet_grad
trap 'rm -f "$ROOT/deployments/.grad-check.tmp"; testnet_cleanup' EXIT
cd "$ROOT/contracts"
for chain in monad hyperevm sepolia; do
  unset SEED_UNIT_BPS LST_SEED_UNIT_BPS EXTRA_SEED_UNIT_BPS # each chain's own default (the previous iteration exported its value)
  testnet_params "$chain"
  export TRADE_ROUNDS
  unset FOUNDRY_GAS_LIMIT # HyperEVM broadcast setting; the in-memory check deploys the whole script contract
  # The loop pairs (shMON/WMON, wstETH/WETH) and the extra pairs are seeded just above the order minimum (little LST;
  # ~2.3 USDC per order would be needed for USDC/WHYPE's 0.1 WHYPE row), so they need not graduate; native/USDC is held
  # to its row
  export EXTRA_ASSET=$ZERO LST=$ZERO
  case $chain in monad) id=10143 ;; hyperevm) id=998 ;; sepolia) id=11155111 ;; esac
  out=$(forge script script/checks/ScriptChecks.s.sol --sig "gradCovered(uint256)" "$id" 2>&1) \
    || { echo "$out" | grep -E "Error|revert|below" | head -5; echo "FAIL: $chain: one seed does not clear GRAD_$id"; exit 1; }
  echo "$out" | grep -E "market volume|grad check OK" | sed "s/^/  $chain: /"
done
echo "grad-seed tests OK"
