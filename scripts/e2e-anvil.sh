#!/usr/bin/env bash
# End-to-end run on a fresh anvil: deploy (demo tokens + graduation table), four full cycles, keeper-driven
# graduation, vaults, a vault fill through non-competitive orders, bootstrap MM, and the vault's epoch roll.
# Usage: scripts/e2e-anvil.sh   (needs foundry, pnpm install done, port 8545 free)
set -euo pipefail
export PATH="$PATH:$HOME/.foundry/bin"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
R=http://127.0.0.1:8545
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # deployer, seeder
ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
PK1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # keeper
PK2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # LP (anvil key 2)
LP=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
FS="--rpc-url $R --broadcast --non-interactive"
J="$ROOT/deployments/anvil.json"
q() { python3 -c "import json;d=json.load(open('$J'));print($1)"; }
keeper() { (cd "$ROOT" && PRIVATE_KEY=$PK1 CHAIN_ID=31337 HINT_PORT=0 POKE_LEAD_S=0 pnpm --filter @confluere/keeper -s once) | grep -oE '"msg":"[a-zA-Z ]+"' | sort | uniq -c || true; }
warp() { if [ "$1" -gt 0 ]; then cast rpc evm_increaseTime "$1" --rpc-url $R >/dev/null; fi; cast rpc evm_mine --rpc-url $R >/dev/null; }
now() { cast block latest -f timestamp --rpc-url $R; }
step() { echo; echo "== $*"; }
sync() { (cd "$ROOT" && pnpm -s codegen >/dev/null 2>&1 && pnpm --filter @confluere/sdk -s build >/dev/null); }

# Only an anvil this script started (pid file of an earlier, interrupted run) is stopped; anything else listening on
# 8545 (a demo chain, another tool) is left alone and the run refuses to start, since it warps time on its chain.
PIDF="${TMPDIR:-/tmp}/confluere-e2e-anvil.pid"
if [ -f "$PIDF" ]; then
  OLD=$(cat "$PIDF")
  case "$(ps -p "$OLD" -o command= 2>/dev/null || true)" in
    *"anvil --port 8545"*) kill "$OLD" 2>/dev/null || true ;;
  esac
  rm -f "$PIDF"
fi
for _ in $(seq 1 20); do cast chain-id --rpc-url $R >/dev/null 2>&1 || break; sleep 0.5; done
if cast chain-id --rpc-url $R >/dev/null 2>&1; then
  echo "FAIL: port 8545 is busy with a chain this script did not start; stop it and re-run"; exit 1
fi
anvil --port 8545 --silent >/dev/null 2>&1 &
ANVIL=$!
echo "$ANVIL" > "$PIDF"
# Scratch directory for forge and bootstrap-MM logs; removed with the anvil on any exit.
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/confluere-e2e.XXXXXX")
cleanup() {
  local rc=$?
  kill $ANVIL 2>/dev/null || true
  rm -f "$PIDF"
  rm -rf "$TMPD"
  exit $rc
}
trap cleanup EXIT
# wait for this run's anvil (30 s at most); stop at once if it exited (e.g. it could not bind the port)
for i in $(seq 1 60); do
  cast chain-id --rpc-url $R >/dev/null 2>&1 && break
  kill -0 $ANVIL 2>/dev/null || { echo "FAIL: anvil failed to start"; exit 1; }
  [ "$i" -lt 60 ] || { echo "FAIL: anvil did not answer on 8545 within 30 s"; exit 1; }
  sleep 0.5
done
# fs PATTERN SCRIPT [args...]: forge script with its output in a log; a failing forge stops the run here with the
# log's tail (not at some later step), a passing one prints the log lines matching PATTERN.
fs() {
  local pat=$1; shift
  forge script "$@" > "$TMPD/forge.log" 2>&1 || { tail -20 "$TMPD/forge.log"; echo "FAIL: forge script $1"; exit 1; }
  grep -E "$pat" "$TMPD/forge.log" || true
}

cd "$ROOT/contracts"
step "deploy (demo grid, demo tokens, graduation baselines)"
TREASURY=$ME GUARDIAN=$ME DEMO=true MOCKS=true fs "SUCCESS|Error" script/Deploy.s.sol $FS --private-key $PK0
fs "positionMarket|Error" script/DeployPositionMarket.s.sol $FS --private-key $PK0
sync

for cycle in 1 2 3 4; do
  step "cycle $cycle: pools, seed, settle, mature, close"
  fs "pools created|Error" script/CreatePools.s.sol $FS --private-key $PK0
  sync
  fs "seeded|Error" script/Seed.s.sol $FS --private-key $PK0
  warp 130; keeper
  EXP=$(q "d['pools']['expiry']"); warp $((EXP - $(now) + 1)); keeper
  cast rpc anvil_mine 301 --rpc-url $R >/dev/null; keeper
done

step "graduation (keeper calls the permissionless graduate)"
fs "pools created|Error" script/CreatePools.s.sol $FS --private-key $PK0
sync
keeper
CORE=$(q "d['confluere']"); NATIVE=$(q "d['pools']['native']"); USD=$(q "d['pools']['usdc']"); LST=$(q "d['pools']['lst']")
M_USD=$(cast keccak $(cast abi-encode "f(address,address,uint8)" $NATIVE $USD 0))
GRAD=$(cast call $CORE "graduated(bytes32)(bool)" $M_USD --rpc-url $R); echo "native/usd american graduated: $GRAD"
[ "$GRAD" = "true" ] || { echo "FAIL: market did not graduate"; exit 1; }

step "vaults, LP deposit"
fs "vaults|Error" script/CreateVaults.s.sol $FS --private-key $PK0
sync
VAULT=$(q "d['vaults']['usdLow']")
cast send $USD "mint(address,uint256)" $LP 100000000000 --rpc-url $R --private-key $PK0 >/dev/null
cast send $USD "approve(address,uint256)" $VAULT 100000000000 --rpc-url $R --private-key $PK2 >/dev/null
cast send $VAULT "requestDeposit(uint256,address,address)" 10000000000 $LP $LP --rpc-url $R --private-key $PK2 >/dev/null
cast send $VAULT "roll()" --rpc-url $R --private-key $PK0 >/dev/null
cast send $VAULT "deposit(uint256,address,address)" 10000000000 $LP $LP --rpc-url $R --private-key $PK2 >/dev/null
echo "LP shares: $(cast call $VAULT 'balanceOf(address)(uint256)' $LP --rpc-url $R)"
echo "target pool: $(cast call $VAULT 'targetPool(address)(bytes32)' $NATIVE --rpc-url $R)"

step "first batch sets the band; vault pokes; second batch fills the vault"
fs "seeded|Error" script/Seed.s.sol $FS --private-key $PK0
warp 130; keeper
PID=$(q "d['pools']['poolIds'][4]")
cast send $VAULT "poke()" --rpc-url $R --private-key $PK1 >/dev/null
fs "seeded|Error" script/Seed.s.sol $FS --private-key $PK0
fs "Error" script/Seed.s.sol --sig "leftover(uint256)" 4 $FS --private-key $PK0
step "bootstrap MM quotes the native/usd pool before the boundary"
NEXT=$(cast call $CORE "nextBatchAt(bytes32)(uint256)" $PID --rpc-url $R | awk '{print $1}'); warp $((NEXT - $(now) - 30))
cast send $NATIVE "mint(address,uint256)" 0x90F79bf6EB2c4f870365E785982E1f101E93b906 1000000000000000000000 --rpc-url $R --private-key $PK0 >/dev/null
cast send $USD "mint(address,uint256)" 0x90F79bf6EB2c4f870365E785982E1f101E93b906 1000000000000 --rpc-url $R --private-key $PK0 >/dev/null
# a different pool than the vault's target: competitive bids rightly take priority over non-competitive ones
PID_MM=$(q "d['pools']['poolIds'][6]")
BMM_STATE="$TMPD/bmm-state.json"   # fresh spend / start / exit record for this run (BSD and GNU mktemp differ on -t)
bmm() { (cd "$ROOT" && STATE_FILE=$BMM_STATE PRIVATE_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 CHAIN_ID=31337 POOLS="$PID_MM:main" \
  PER_BATCH_QUOTE=1000000000 TOTAL_QUOTE=10000000000 LEAD_S=90 pnpm --filter @confluere/bootstrap-mm -s once); }
bmm | tee "$TMPD/bmm.log" | grep -oE '"msg":"[a-zA-Z -]+"' | sort | uniq -c || true
grep -q '"msg":"bootstrap bid"' "$TMPD/bmm.log" || { echo "FAIL: bootstrap MM placed no bid"; exit 1; }
warp 40; keeper
CID=$(python3 -c "print(int('$PID',16))")
VC=$(cast call $CORE "balanceOf(address,uint256)(uint256)" $VAULT $CID --rpc-url $R | awk '{print $1}')
echo "vault C units in target pool: $VC"
[ "$VC" != "0" ] || { echo "FAIL: vault order did not fill"; exit 1; }

step "seat: buy the native/usd market-maker seat, meet the obligation with a locked order"
REG=$(q "d['seatRegistry']")
cast send $USD "approve(address,uint256)" $REG 100000000000 --rpc-url $R --private-key $PK2 >/dev/null
cast send $NATIVE "mint(address,uint256)" $LP 100000000000000000000 --rpc-url $R --private-key $PK0 >/dev/null
cast send $REG "buy(address,address,uint8,uint128,uint128,uint256)" $NATIVE $USD 0 1000000000 100000000 0 --rpc-url $R --private-key $PK2 >/dev/null
SEAT=$(cast call $REG "seats(bytes32)(address,uint128,uint128,uint128,uint64,uint64,uint64)" $M_USD --rpc-url $R | head -1)
echo "seat holder: $SEAT"
[ "$(echo $SEAT | tr A-F a-f)" = "$(echo $LP | tr A-F a-f)" ] || { echo "FAIL: seat not bought"; exit 1; }
# obligation orders must sit near the market (BUY >= last P* x (1 - band)): bid 95% of the last clearing price
LCP=$(cast call $CORE "pool(bytes32)" $PID --rpc-url $R | python3 -c "import sys;h=sys.stdin.read().strip()[2:];w=[int(h[i:i+64],16) for i in range(0,len(h),64)];print(w[14])")  # PoolView word 14 = lastClearingPrice
SEAT_LIMIT=$((LCP * 95 / 100)); echo "last P* $LCP, seat bid $SEAT_LIMIT"
HINT=$(cast call $CORE "findHint(bytes32,uint8,uint96)(uint64)" $PID 1 $SEAT_LIMIT --rpc-url $R | awk '{print $1}')
QUOTED=$(cast keccak "Quoted(bytes32,bytes32,uint64,uint64)")
OID=$(cast send $REG "postOrder(bytes32,(uint8,uint96,uint96,uint128,uint16,uint64,address))" $PID "(1,10000000000000000000,$SEAT_LIMIT,0,2,$HINT,0x0000000000000000000000000000000000000000)" --rpc-url $R --private-key $PK2 --json \
  | python3 -c "import sys,json;r=json.load(sys.stdin);print(next(int(l['data'][2:66],16) for l in r['logs'] if l['topics'][0]=='$QUOTED'))")
if cast send $CORE "cancelOrder(bytes32,uint64)" $PID $OID --rpc-url $R --private-key $PK2 >/dev/null 2>&1; then echo "FAIL: locked seat order was cancellable"; exit 1; fi
echo "seat order $OID locked: cancel rejected"
bmm | tee "$TMPD/bmm2.log" | grep -oE '"reason":"[a-z ]+"' || true
grep -q '"reason":"seats cover every market"' "$TMPD/bmm2.log" || { echo "FAIL: bootstrap MM did not exit once seats cover its market"; exit 1; }
rm -f "$BMM_STATE" "$TMPD/bmm2.log"

step "seat: the holder leaves voluntarily (Vacated reason 2), then buys it back"
cast send $REG "release(address,address,uint8)" $NATIVE $USD 0 --rpc-url $R --private-key $PK2 >/dev/null
SEAT=$(cast call $REG "seats(bytes32)(address,uint128,uint128,uint128,uint64,uint64,uint64)" $M_USD --rpc-url $R | head -1)
[ "$SEAT" = "0x0000000000000000000000000000000000000000" ] || { echo "FAIL: release did not vacate the seat"; exit 1; }
cast send $REG "buy(address,address,uint8,uint128,uint128,uint256)" $NATIVE $USD 0 1000000000 100000000 0 --rpc-url $R --private-key $PK2 >/dev/null
echo "released and bought back"

step "seat holder skips two batches; the keeper slashes the seat"
warp 250; keeper
SEAT=$(cast call $REG "seats(bytes32)(address,uint128,uint128,uint128,uint64,uint64,uint64)" $M_USD --rpc-url $R | head -1)
echo "seat holder after keeper: $SEAT"
[ "$SEAT" = "0x0000000000000000000000000000000000000000" ] || { echo "FAIL: missed batch was not slashed"; exit 1; }

step "expiry: borrowers default, window closes, vault rolls the epoch"
EXP=$(q "d['pools']['expiry']"); warp $((EXP - $(now) + 1)); keeper
cast rpc anvil_mine 301 --rpc-url $R >/dev/null; keeper; keeper
EPOCH=$(cast call $VAULT "epoch()(uint64)" --rpc-url $R); echo "vault epoch now: $EPOCH"
cast call $VAULT "pendingAssetCredit(address,address)(uint256)" $LP $NATIVE --rpc-url $R | xargs echo "LP defaulted-asset credit:"
[ "$EPOCH" = "3" ] || { echo "FAIL: vault did not roll"; exit 1; }
step "long-tail pool: 12x batch cadence, minimum fill, first-auction bounds"
G=$(cast call $CORE "grid()((uint64,uint64,uint64,uint8,uint8))" --rpc-url $R | sed -E 's/ \[[^]]*\]//g' | tr -d '()' | tr ',' ' ')
read -r GA GP GB _ _ <<<"$G"
LEXP=$((GA + (($(now) - GA) / GP + 2) * GP))
cast send $NATIVE "approve(address,uint256)" $CORE 1 --rpc-url $R --private-key $PK0 >/dev/null
cast send $USD "approve(address,uint256)" $CORE 1 --rpc-url $R --private-key $PK0 >/dev/null
cast send $CORE "createPoolWithOptions((address,address,uint64,uint128,uint8),uint16,uint16,(uint8,uint96,uint96,uint96))" "($NATIVE,$USD,$LEXP,25000000,0)" 1000 800 "(1,5000000000000000000,20000000,24000000)" --rpc-url $R --private-key $PK0 >/dev/null
LPID=$(python3 -c "h='$(cast keccak $(cast abi-encode "f((address,address,uint64,uint128,uint8))" "($NATIVE,$USD,$LEXP,25000000,0)"))';print(hex(int(h,16)&~1)[:2]+format(int(h,16)&~1,'064x'))")
LIV=$(cast call $CORE "pool(bytes32)" $LPID --rpc-url $R | python3 -c "import sys;h=sys.stdin.read().strip()[2:];print(int(h[-64:],16))")
echo "long-tail pool batch interval: ${LIV}s (base ${GB}s)"
[ "$LIV" = "$((GB * 12))" ] || { echo "FAIL: long-tail cadence"; exit 1; }

echo; echo "E2E OK"
