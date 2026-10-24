#!/usr/bin/env bash
# Offline tests for scripts/lib/testnet.sh, scripts/deploy-testnet.sh and scripts/roll-testnet.sh. cast, forge, pnpm,
# node and sleep are replaced by fakes on PATH that log every call, so nothing touches a chain; the two entry scripts
# run end to end from a copy of scripts/ with a dummy contracts/.env, and the tests assert the call sequence.
# Runs on macOS and Linux (CI): bash scripts/test/testnet-lib.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d "${TMPDIR:-/tmp}/testnet-lib.XXXXXX")
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/root/deployments" "$T/root/contracts" "$T/root/packages/sdk" "$T/state"
cp -R "$ROOT/scripts" "$T/root/scripts"
echo "PRIVATE_KEY=0x01" > "$T/root/contracts/.env"
CALLS="$T/calls.log"
export CALLS XDG_STATE_HOME="$T/state"

cat > "$T/bin/cast" <<'EOF'
#!/usr/bin/env bash
echo "cast $*" >> "$CALLS"
# FAKE_CAST_FAIL=<subcommand>: that read fails every time (an RPC that stays down through rcast's retries)
[ "${FAKE_CAST_FAIL:-}" != "$1" ] || { echo "Error: connection refused" >&2; exit 1; }
case "$1" in
  chain-id) case "$*" in *monad*) echo 10143 ;; *sepolia*) echo 11155111 ;; *) echo 998 ;; esac ;;
  wallet) echo 0x00000000000000000000000000000000000000Aa ;;
  balance) echo "${FAKE_GAS:-0}" ;;
  code) echo 0x6080 ;;
  block) echo "${FAKE_NOW:-0}" ;;
  send) ;;
  call)
    case "$3" in
      "decimals()(uint8)")
        case "$2" in 0x2B3370eE501B4a559b57D449569354196457D8Ab|0x534b2f3A21130d7a60830c2Df862319e593943A3|0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) echo 6 ;; *) echo 18 ;; esac ;;
      "balanceOf(address)(uint256)")
        case "$2" in
          0x2B3370eE501B4a559b57D449569354196457D8Ab|0x534b2f3A21130d7a60830c2Df862319e593943A3|0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238) echo "${FAKE_BAL_USDC:-${FAKE_BAL:-0}} [x]" ;;
          *) echo "${FAKE_BAL:-0} [x]" ;;
        esac ;;
      "pool(bytes32)") if [ -n "${FAKE_POOL_SHORT:-}" ]; then echo 0x; else printf '0x%0320d%064x\n' 0 "${FAKE_STATUS:-1}"; fi ;;
      "grid()((uint64,uint64,uint64,uint32,uint8))") echo "(1791532800 [1.791e9], 3600, 120, 4, 2)" ;;
      "getStETHByWstETH(uint256)(uint256)") echo "1037717825760305089 [1.037e18]" ;; # a fixed answer, whatever the input
    esac ;;
esac
EOF
# forge: like the real one it writes DEPLOYMENTS_FILE while simulating (before a failure can happen; --resume does not
# simulate, so it writes nothing) and keeps the broadcast of `--sig f()` in broadcast/<script>/<chainId>/f-latest.json.
# FAKE_FAIL=<Script.sig> (or all) fails that step after broadcasting, or before broadcasting with FAKE_NO_BROADCAST=1.
# Deploy keeps the deploy block DEPLOYMENTS_FILE or else DEPLOYMENTS_FALLBACK records for its core, else uses
# FAKE_BLOCK (Deploy.s.sol _deployBlock).
cat > "$T/bin/forge" <<'EOF'
#!/usr/bin/env bash
script=$2 sig=run prev="" resume=0 cid=998 sim=1
for a in "$@"; do
  if [ "$prev" = --sig ]; then sig=${a%%(*}; fi
  [ "$a" = --resume ] && resume=1
  [ "$a" = --skip-simulation ] && sim=0
  case "$a" in *monad*) cid=10143 ;; *sepolia*) cid=11155111 ;; esac
  prev=$a
done
key="$(basename "$script" .s.sol).$sig"
echo "forge $key resume=$resume EXPIRY=${EXPIRY:-} NATIVE=${NATIVE:-} CLAIM_POOLS=${CLAIM_POOLS:-} BPS=${SEED_UNIT_BPS:-} EXTRA=${EXTRA_ASSET:-} XQ=${EXTRA_QUOTE:-} XBPS=${EXTRA_SEED_UNIT_BPS:-} LBPS=${LST_SEED_UNIT_BPS:-} SALT=${SALT:-} GRAD=${GRAD_11155111:+sepolia} sim=$sim" >> "$CALLS"
if [ -n "${DEPLOYMENTS_FILE:-}" ] && [ $resume = 0 ]; then
  python3 - "$key" "$cid" <<'PY'
import json, os, sys
key, cid = sys.argv[1], int(sys.argv[2])
f = os.environ["DEPLOYMENTS_FILE"]
try:
    d = json.load(open(f))
except Exception:
    d = {}
core = "0x00000000000000000000000000000000000000c0"
if key == "Deploy.run":
    block = int(os.environ.get("FAKE_BLOCK", "100"))
    for r in [d] + [json.load(open(x)) for x in [os.environ.get("DEPLOYMENTS_FALLBACK", "")] if os.path.isfile(x)]:
        if r.get("confluere") == core and "deployBlock" in r:
            block = r["deployBlock"]
            break
    d = {"chainId": cid, "confluere": core, "router": "0x00000000000000000000000000000000000000c1", "gridPeriod": 3600,
         "deployBlock": block}
elif key == "CreatePools.run":
    e = int(os.environ.get("EXPIRY") or os.environ.get("FAKE_NEXT", "1791540000"))
    d["pools"] = {"lst": os.environ.get("LST", ""), "native": os.environ["NATIVE"], "usdc": os.environ["USDC"],
                  "expiry": e, "poolIds": ["0x%064x" % e]}
    xa = os.environ.get("EXTRA_ASSET", "")
    if xa and int(xa, 16) != 0:  # CreatePools records the extra pair only when there is one
        d["pools"].update(extraAsset=xa, extraQuote=os.environ["EXTRA_QUOTE"], poolIds=["0x%064x" % e, "0x%064x" % (e + 1)])
elif key == "DeployPositionMarket.run":
    d["positionMarket"] = "0x00000000000000000000000000000000000000d0"
elif key == "DeploySeatLP.run":
    d["seatLPTokens"] = {"%s-%s-0" % (d["pools"]["native"], d["pools"]["usdc"]): "0x00000000000000000000000000000000000000d1"}
elif key == "CreateVaults.run":
    d["vaults"] = {"usdLow": "0x00000000000000000000000000000000000000e0"}
    p = d.get("pools", {})
    # mirrors CreateVaults.s.sol: the native-coin vault only when the extra pair lends the native coin
    if "extraAsset" in p and p.get("extraQuote", "").lower() == p.get("native", "").lower():
        d["vaults"]["nativeLend"] = "0x00000000000000000000000000000000000000e2"
json.dump(d, open(f, "w"))
PY
fi
latest="broadcast/$(basename "$script")/$cid/$sig-latest.json"
mkdir -p "$(dirname "$latest")"
if [ "${FAKE_FAIL:-}" = "$key" ] || [ "${FAKE_FAIL:-}" = all ]; then
  [ "${FAKE_NO_BROADCAST:-0}" = 1 ] || touch "$latest"
  echo "Error: broadcast failed"; exit 1
fi
touch "$latest"
echo "pools created 1"
EOF
cat > "$T/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "pnpm cwd=$(basename "$PWD") CHAINS=${CHAINS:-} DEPLOYMENT=${DEPLOYMENT:-} CRE_CONFIG=${CRE_CONFIG:-} RPC=${RPC_URL:-} $*" >> "$CALLS"
echo '"ok"'
EOF
cat > "$T/bin/node" <<'EOF'
#!/usr/bin/env bash
echo "node cwd=$(basename "$PWD") $*" >> "$CALLS"
EOF
cat > "$T/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >> "$CALLS"
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" RETRY_SLEEP=0 PRIVATE_KEY=0x01 FAKE_BAL=1000000000000000000000 FAKE_GAS=10000000000000000000
export TRADE_ROUNDS=0 # the trade step has its own case below; the step sequences leave it out

fail() { echo "FAIL: $*"; [ -f "$T/out" ] && sed 's/^/  | /' "$T/out"; exit 1; }
# The call log condensed to the steps that matter, consecutive repeats folded:
# Script.sig (! = --resume), bb-on/bb-off, fund (balance reads), sdk, cre:<DEPLOYMENT>, sleep.
seq_of() {
  python3 - "$CALLS" <<'PY'
import sys
out = []
for line in open(sys.argv[1]):
    w = line.split()
    tok = None
    if w[0] == "forge":
        tok = w[1] + ("!" if "resume=1" in w else "")
    elif w[0] == "pnpm" and "big-blocks" in w:
        tok = "bb-" + w[-1]
    elif w[0] == "pnpm" and "sync-config" in w:
        tok = "cre:" + w[3].split("=", 1)[1]
    elif w[0] == "node" and "scripts/sync-deployments.mjs" in w:
        tok = "sdk" if w[1] == "cwd=sdk" else "sdk@" + w[1]
    elif w[0] == "cast" and "balanceOf(address)(uint256)" in w:
        tok = "fund"
    elif w[0] == "sleep" and w[1] != "0":
        tok = "sleep"
    if tok and (not out or out[-1] != tok):
        out.append(tok)
print(" ".join(out))
PY
}
expect_seq() { local got; got=$(seq_of); [ "$got" = "$1" ] || fail "$2: calls were '$got', want '$1'"; }
forge_line() { grep "^forge $1 " "$CALLS" | tail -1; }
# Each lib case runs in its own shell: the library installs an EXIT trap and calls exit on failure.
# LIBCHAIN picks the chain (default hyperevm).
lib() { bash -c "set -euo pipefail; ROOT='$T/root'; cd '$T/root/contracts'; . '$ROOT/scripts/lib/testnet.sh'; testnet_env ${LIBCHAIN:-hyperevm}; $1"; }
DEP="$T/root/deployments"
SCR="$T/root/scripts"
OLD=0x00000000000000000000000000000000000000d0

# ---------------------------------------------------------------- lib
# mtime: GNU or BSD stat, whichever this system has, gives epoch seconds
touch "$T/f"
m=$(bash -c ". '$ROOT/scripts/lib/testnet.sh' 2>/dev/null; mtime '$T/f'")
[ $(( $(date +%s) - m )) -lt 60 ] || fail "mtime gave '$m'"

# run: a failed broadcast leaves deployments/<chain>.json untouched, and retries resume its own broadcast
echo "{\"chainId\":998,\"confluere\":\"$OLD\"}" > "$DEP/hyperevm-testnet.json"
: > "$CALLS"
if FAKE_FAIL=all lib 'STEP=pools; run pools script/CreatePools.s.sol 1' > "$T/out" 2>&1; then fail "run succeeded on a failing forge"; fi
grep -q "\"$OLD\"" "$DEP/hyperevm-testnet.json" || fail "deployments file changed by a failed step"
grep -q '"pools"' "$DEP/hyperevm-testnet.json" && fail "failed step wrote pools"
grep -q "RESUME=1 .* hyperevm pools" "$T/out" || fail "no resume hint naming the step after failure"
[ "$(grep -c '^forge' "$CALLS")" = 3 ] || fail "expected three tries"
[ "$(seq_of)" = "CreatePools.run CreatePools.run!" ] || fail "retries did not resume: $(seq_of)"
[ -f "$DEP/.staging/.gitignore" ] || fail "staging dir kept after a failure is not git-ignored"

# run: RESUME=1 resumes the failed attempt's broadcast and its staged JSON; success replaces the file after verification
: > "$CALLS"
RESUME=1 lib 'run pools script/CreatePools.s.sol 1' > "$T/out" 2>&1 || fail "resumed run failed"
grep -q '"pools"' "$DEP/hyperevm-testnet.json" || fail "file not replaced"
expect_seq "CreatePools.run!" "RESUME=1"
[ ! -d "$DEP/.staging" ] || fail "staging dir left behind"

# run: RESUME=1 refuses when the last attempt finished (nothing to resume) instead of replaying the old broadcast
: > "$CALLS"
if RESUME=1 lib 'run pools script/CreatePools.s.sol 1' > "$T/out" 2>&1; then fail "resumed a finished step"; fi
grep -q "no interrupted broadcast" "$T/out" || fail "no explanation for a refused RESUME"
grep -q "^forge" "$CALLS" && fail "forge ran on a refused RESUME"

# run: a broadcast whose pools are not on chain does not replace the file
echo "{\"chainId\":998,\"confluere\":\"$OLD\"}" > "$DEP/hyperevm-testnet.json"
if FAKE_STATUS=0 lib 'run pools script/CreatePools.s.sol 1' > "$T/out" 2>&1; then fail "unverified pools accepted"; fi
grep -q '"pools"' "$DEP/hyperevm-testnet.json" && fail "file replaced without verification"
rm -rf "$DEP/.staging"

# verify_stage: RPC reads that keep failing (code, pool) or a truncated pool() answer fail the check, so the file is
# not replaced on the strength of reads that never happened
for c in "FAKE_CAST_FAIL=code" "FAKE_CAST_FAIL=call" "FAKE_POOL_SHORT=1"; do
  echo "{\"chainId\":998,\"confluere\":\"$OLD\"}" > "$DEP/hyperevm-testnet.json"
  if (export "${c?}"; lib 'run pools script/CreatePools.s.sol 1') > "$T/out" 2>&1; then
    fail "verify passed with $c"
  fi
  grep -q '"pools"' "$DEP/hyperevm-testnet.json" && fail "file replaced although verification could not read the chain ($c)"
  grep -q "verify: " "$T/out" || fail "no verify message for $c"
  rm -rf "$DEP/.staging"
done

# run Deploy again over a deployment of the same core: .pools, .vaults, .positionMarket and .seatLPTokens (recorded by
# later steps) are kept; over a
# file naming another core they are dropped
python3 - "$DEP/hyperevm-testnet.json" <<'PY'
import json, sys
json.dump({"chainId": 998, "confluere": "0x00000000000000000000000000000000000000c0", "deployBlock": 7,
           "pools": {"native": "0x00000000000000000000000000000000000000e1", "usdc": "0x2B3370eE501B4a559b57D449569354196457D8Ab",
                     "lst": "0x0000000000000000000000000000000000000000", "expiry": 5, "poolIds": ["0x%064x" % 5]},
           "vaults": {"usdLow": "0x00000000000000000000000000000000000000e0"},
           "positionMarket": "0x00000000000000000000000000000000000000d0",
           "seatLPTokens": {"a-b-0": "0x00000000000000000000000000000000000000d1"}}, open(sys.argv[1], "w"))
PY
lib 'run deploy script/Deploy.s.sol 1' > "$T/out" 2>&1 || fail "Deploy re-run failed"
python3 - "$DEP/hyperevm-testnet.json" <<'PY' || fail "Deploy re-run dropped .pools / .vaults / .positionMarket / .seatLPTokens of the same core"
import json, sys
d = json.load(open(sys.argv[1]))
assert d["pools"]["poolIds"] == ["0x%064x" % 5] and d["vaults"]["usdLow"].endswith("e0") and d["deployBlock"] == 7, d
assert d["positionMarket"].endswith("d0") and d["seatLPTokens"]["a-b-0"].endswith("d1"), d
PY
python3 - "$DEP/hyperevm-testnet.json" "$OLD" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["confluere"] = sys.argv[2]; json.dump(d, open(sys.argv[1], "w"))
PY
lib 'run deploy script/Deploy.s.sol 1' > "$T/out" 2>&1 || fail "Deploy over another core failed"
grep -qE '"pools"|"vaults"|"positionMarket"|"seatLPTokens"' "$DEP/hyperevm-testnet.json" && fail "records of another core carried over"
rm -rf "$DEP/.staging"

# run: Seed.run and Seed.collect (--sig) keep separate markers: a finished collect does not clear the marker an
# interrupted seed left, so RESUME=1 on the seed still resumes it
if FAKE_FAIL=Seed.run lib 'STEP=seed; run seed script/Seed.s.sol 0' > "$T/out" 2>&1; then fail "failing seed passed"; fi
lib 'run collect script/Seed.s.sol 0 --sig "collect()"' > "$T/out" 2>&1 || fail "collect failed"
: > "$CALLS"
RESUME=1 lib 'run seed script/Seed.s.sol 0' > "$T/out" 2>&1 || fail "seed not resumable after a finished collect"
expect_seq "Seed.run!" "RESUME=1 seed after a finished collect"
rm -rf "$DEP/.staging"

# bigblocks: switched back off when a step exits halfway
: > "$CALLS"
if lib 'bigblocks on; exit 1' > "$T/out" 2>&1; then :; fi
expect_seq "bb-on bb-off" "big blocks after a failed step"

# preflight: stops with a clear message before any pool when balances fall short
if FAKE_BAL=1000 lib 'preflight' > "$T/out" 2>&1; then fail "preflight passed when short"; fi
grep -q "STOP: balances do not cover one seed" "$T/out" || fail "no stop message"
grep -q "faucet.circle.com" "$T/out" || fail "no USDC hint"
TRADE_ROUNDS=3 lib 'preflight' > "$T/out" 2>&1 || fail "preflight failed when funded"
# Book layout (SEED_APR_BPS=1000) at one strike per pair, one expiry, 3 trade rounds: per pool and kind 5 sells and 5
# buys of one unit, each buy escrowing quoteUp(u x K) + ttl (SEED_TTL=1000). HyperEVM: WHYPE/USDC at 0.001 WHYPE,
# K 75 USDC: 10 x (75000 + 1000) USDC and 10 x 1e15 WHYPE; the extra pair USDC/WHYPE at 0.2 USDC, K 0.011 WHYPE:
# 10 x 200000 USDC and 10 x (2.2e15 + 1000) WHYPE
grep -qE "usdc +need 2760000 " "$T/out" || fail "HyperEVM USDC need misses the extra pair: $(grep usdc "$T/out")"
grep -qE "native +need 32000000000010000 " "$T/out" || fail "HyperEVM WHYPE need misses the extra pair: $(grep native "$T/out")"
grep -qE "^  extra" "$T/out" && fail "the extra pair's tokens (USDC, WHYPE) were counted as separate tokens"
if TRADE_ROUNDS=3 FAKE_BAL_USDC=2759999 lib 'preflight' > "$T/out" 2>&1; then fail "preflight passed 1 unit short of the extra pair's USDC"; fi
grep -q "faucet.circle.com" "$T/out" || fail "no USDC hint when only the extra pair is short"
# Monad, USDC: WMON/USDC at 0.02 WMON, K 0.022: 10 x (440 + 1000); shMON/USDC at 0.005 shMON: 10 x (110 + 1000) = 25500.
# Just below that must stop (the seed would revert halfway); exactly that passes. Three expiries triple it.
if TRADE_ROUNDS=3 LIBCHAIN=monad FAKE_BAL_USDC=25499 lib 'preflight' > "$T/out" 2>&1; then fail "preflight passed 1 wei short of the buys' escrow"; fi
grep -qE "usdc +need 25500 " "$T/out" || fail "USDC need is not the escrow sum: $(grep usdc "$T/out")"
TRADE_ROUNDS=3 LIBCHAIN=monad FAKE_BAL_USDC=25500 lib 'preflight' > "$T/out" 2>&1 || fail "preflight failed with exactly the escrow"
TRADE_ROUNDS=3 LIBCHAIN=monad LATER_EXPIRIES=5,6 lib 'preflight' > "$T/out" 2>&1 || true
grep -qE "usdc +need 76500 " "$T/out" || fail "LATER_EXPIRIES not counted: $(grep usdc "$T/out")"
# the ttl preflight counts is the one Seed.s.sol places (it reads SEED_TTL)
grep -q 'vm.envOr("SEED_TTL"' "$ROOT/contracts/script/Seed.s.sol" || fail "Seed.s.sol does not read SEED_TTL"

# launch_expiries on a daily grid: the first expiry at least 12 h away, then 6 and 13 days later
python3 - "$DEP/hyperevm-testnet.json" <<'PY'
import json, sys
json.dump({"chainId": 998, "confluere": "0x00000000000000000000000000000000000000c0", "gridPeriod": 86400,
           "gridAnchor": 1791532800, "batchInterval": 120, "deployBlock": 1}, open(sys.argv[1], "w"))
PY
out=$(FAKE_NOW=$((1791532800 + 10 * 86400 - 13 * 3600)) lib 'launch_expiries >/dev/null; echo "$EXPIRY $LATER_EXPIRIES"')
[ "$out" = "$((1791532800 + 10 * 86400)) $((1791532800 + 16 * 86400)),$((1791532800 + 23 * 86400))" ] || fail "launch expiries: $out"
out=$(FAKE_NOW=$((1791532800 + 10 * 86400 - 11 * 3600)) lib 'launch_expiries >/dev/null; echo "$EXPIRY"')
[ "$out" = $((1791532800 + 11 * 86400)) ] || fail "launch expiry less than 12 h away: $out"
# trade_rounds: a tick before every round (one batch apart) and a last one
: > "$CALLS"
FAKE_NOW=$((1791532800 + 30)) TRADE_ROUNDS=2 lib 'trade_rounds' > "$T/out" 2>&1 || fail "trade rounds failed"
expect_seq "sleep Seed.tick Seed.trade sleep Seed.tick Seed.trade sleep Seed.tick" "trade rounds"
grep -q "^sleep 105" "$CALLS" || fail "trade rounds: not waiting for the batch boundary"
: > "$CALLS"
FAKE_BAL=9000000 FUND=1 lib 'preflight' > "$T/out" 2>&1 || true
grep -q 'cast send 0x5555555555555555555555555555555555555555 deposit()' "$CALLS" || fail "FUND=1 did not wrap"

# ---------------------------------------------------------------- deploy-testnet.sh
# whole run: deploy (big blocks), fund, pools, seed, vaults, market and seatlp (big blocks), then the SDK
rm -f "$DEP"/*.json
: > "$CALLS"
"$SCR/deploy-testnet.sh" hyperevm > "$T/out" 2>&1 || fail "deploy-testnet.sh hyperevm failed"
expect_seq "bb-on Deploy.run bb-off fund CreatePools.run Seed.run bb-on CreateVaults.run bb-off bb-on DeployPositionMarket.run bb-off bb-on DeploySeatLP.run bb-off sdk" \
  "deploy-testnet.sh hyperevm"
grep -q 'BPS=10 ' <<<"$(forge_line Seed.run)" || fail "seed not at the chain's SEED_UNIT_BPS=10"
grep -q '"usdLow"' "$DEP/hyperevm-testnet.json" || fail "vaults not recorded"
grep -q '"positionMarket"' "$DEP/hyperevm-testnet.json" || fail "PositionMarket not recorded"
grep -q '"seatLPTokens"' "$DEP/hyperevm-testnet.json" || fail "SeatLP tokens not recorded"
grep -q "EXTRA=0x2B3370eE501B4a559b57D449569354196457D8Ab XQ=0x5555555555555555555555555555555555555555 " \
  <<<"$(forge_line CreatePools.run)" || fail "HyperEVM pools without the USDC/WHYPE extra pair"
grep -q 'XBPS=2000' <<<"$(forge_line Seed.run)" || fail "extra pair not seeded at EXTRA_SEED_UNIT_BPS=2000"
grep -q '"nativeLend"' "$DEP/hyperevm-testnet.json" || fail "extra-pair vault not recorded as vaults.nativeLend"

# Monad also regenerates the CRE workflow config (it targets monad-testnet)
: > "$CALLS"
FAKE_BLOCK=40 "$SCR/deploy-testnet.sh" monad > "$T/out" 2>&1 || fail "deploy-testnet.sh monad failed"
expect_seq "Deploy.run fund CreatePools.run Seed.run CreateVaults.run DeployPositionMarket.run DeploySeatLP.run sdk cre:monad-testnet" \
  "deploy-testnet.sh monad"
grep -qi "EXTRA=0x282BdDFF5e58793AcAb65438b257Dbd15A8745C9 " <<<"$(forge_line CreatePools.run)" \
  || fail "Monad pools miss the shMON/USDC extra pair"
grep -qE '"nativeLend"' "$DEP/monad-testnet.json" && fail "Monad deployment records a native-coin lending vault (its extra pair lends USDC)"

# a failed step names itself in the hint; RESUME=1 resumes only that step, the next ones run afresh
: > "$CALLS"
if FAKE_FAIL=Seed.run "$SCR/deploy-testnet.sh" monad seed > "$T/out" 2>&1; then fail "failing seed passed"; fi
grep -q "RESUME=1 $SCR/deploy-testnet.sh monad seed" "$T/out" || fail "deploy hint does not name the seed step"
: > "$CALLS"
RESUME=1 "$SCR/deploy-testnet.sh" monad seed > "$T/out" 2>&1 || fail "RESUME=1 seed failed"
expect_seq "Seed.run! CreateVaults.run DeployPositionMarket.run DeploySeatLP.run sdk cre:monad-testnet" "RESUME=1 deploy-testnet.sh monad seed"

# a Deploy that landed the core and then failed: the re-run (without RESUME) keeps that attempt's deploy block
echo "{\"chainId\":10143,\"confluere\":\"$OLD\",\"deployBlock\":1}" > "$DEP/monad-testnet.json"
if FAKE_FAIL=Deploy.run FAKE_BLOCK=50 "$SCR/deploy-testnet.sh" monad > "$T/out" 2>&1; then fail "failing deploy passed"; fi
FAKE_BLOCK=90 "$SCR/deploy-testnet.sh" monad > "$T/out" 2>&1 || fail "deploy re-run failed"
[ "$(python3 -c "import json;print(json.load(open('$DEP/monad-testnet.json'))['deployBlock'])")" = 50 ] \
  || fail "deploy re-run moved the log-scan start block"

# a staged Deploy file left by an attempt that named another core (other GRAD rows): the deploy block comes from
# deployments/<chain>.json, which names this core (DEPLOYMENTS_FALLBACK), not from the current block
mkdir -p "$DEP/.staging"
echo "{\"chainId\":10143,\"confluere\":\"$OLD\",\"deployBlock\":1}" > "$DEP/.staging/monad-testnet.Deploy.json"
FAKE_BLOCK=120 "$SCR/deploy-testnet.sh" monad > "$T/out" 2>&1 || fail "deploy over a stale stage failed"
[ "$(python3 -c "import json;print(json.load(open('$DEP/monad-testnet.json'))['deployBlock'])")" = 50 ] \
  || fail "a stale Deploy stage hid the recorded deploy block"

# ---------------------------------------------------------------- roll-testnet.sh
A=1791532800; P=3600; E0=$((A + 100 * P))
NAT=0x00000000000000000000000000000000000000e1 # not the default WMON: tokens come from .pools
write_monad() { # write_monad EXPIRY
  python3 - "$DEP/monad-testnet.json" "$1" "$NAT" <<'PY'
import json, sys
f, e, nat = sys.argv[1], int(sys.argv[2]), sys.argv[3]
d = {"chainId": 10143, "confluere": "0x00000000000000000000000000000000000000c0", "gridPeriod": 3600, "deployBlock": 1,
     "pools": {"lst": "0x282BdDFF5e58793AcAb65438b257Dbd15A8745C9", "native": nat,
               "usdc": "0x534b2f3A21130d7a60830c2Df862319e593943A3", "expiry": e, "poolIds": ["0x%064x" % e]}}
json.dump(d, open(f, "w"))
PY
}
jexp() { python3 -c "import json;print(json.load(open('$DEP/monad-testnet.json'))['pools']['expiry'])"; }
id_of() { printf '0x%064x' "$1"; }
rm -rf "$T/state"/* "$DEP/.staging"
write_monad $E0

# one roll: collect (earlier pools), fund, the next consecutive expiry with the deployment's tokens, seed, sync
: > "$CALLS"
FAKE_NOW=$((E0 - 1800)) "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1 || fail "roll failed"
expect_seq "Seed.collect fund CreatePools.run Seed.run sdk cre:monad-testnet" "roll-testnet.sh monad"
grep -q "CLAIM_POOLS=$(id_of $E0)" <<<"$(forge_line Seed.collect)" || fail "collect without the earlier pool ids"
grep -q "EXPIRY=$((E0 + P)) NATIVE=$NAT " <<<"$(forge_line CreatePools.run)" || fail "pools: wrong expiry or tokens"
grep -q 'BPS=200 ' <<<"$(forge_line Seed.run)" || fail "roll seed not at Monad's 200 bps"
[ "$(jexp)" = $((E0 + P)) ] || fail "deployments not rolled"
grep -q "2 consecutive expiries" "$T/out" || fail "consecutive count not reported"
grep -qx "$(id_of $E0)" "$T/state/confluere/roll-monad-testnet-0x00000000000000000000000000000000000000c0.txt" \
  || fail "earlier pool ids not remembered"

# second roll right away: still opens the following expiry (four may be listed ahead), and claims both earlier sets
: > "$CALLS"
FAKE_NOW=$((E0 - 1700)) "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1 || fail "second roll failed"
grep -q "EXPIRY=$((E0 + 2 * P)) " <<<"$(forge_line CreatePools.run)" || fail "second roll: not the next expiry"
grep -q "CLAIM_POOLS=$(id_of $E0),$(id_of $((E0 + P)))" <<<"$(forge_line Seed.collect)" || fail "claims not accumulated"
grep -q "3 consecutive expiries" "$T/out" || fail "count not increased"

# past the listing limit: waits in the foreground, then opens the consecutive expiry; NO_WAIT=1 stops before pools
NOW=$((E0 + 3 * P - 4 * P - 100))
: > "$CALLS"
if NO_WAIT=1 FAKE_NOW=$NOW "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1; then fail "NO_WAIT=1 did not stop"; fi
grep -q "^forge CreatePools" "$CALLS" && fail "NO_WAIT=1 still created pools"
: > "$CALLS"
FAKE_NOW=$NOW "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1 || fail "waiting roll failed"
expect_seq "Seed.collect fund sleep CreatePools.run Seed.run sdk cre:monad-testnet" "waiting roll"
grep -q "EXPIRY=$((E0 + 3 * P)) " <<<"$(forge_line CreatePools.run)" || fail "after waiting: not the next expiry"
grep -q "4 consecutive expiries" "$T/out" || fail "count after wait"

# too late for the next expiry: warns, opens the nearest one, and reports the chain broken once it is
: > "$CALLS"
FAKE_NOW=$((E0 + 4 * P - 60)) FAKE_NEXT=$((E0 + 5 * P)) "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1 || fail "late roll failed"
grep -q "WARNING: late roll" "$T/out" || fail "late roll not reported"
grep -q "expiry chain broken: $((E0 + 5 * P)) " "$T/out" || fail "broken chain not reported"
grep -q "EXPIRY= " <<<"$(forge_line CreatePools.run)" || fail "late roll forced a past expiry"
grep -q "1 consecutive expiries" "$T/out" || fail "count not reset"

# RESUME: refused when nothing was interrupted; a failed seed resumes only the seed (no new expiry, no new collect)
: > "$CALLS"
if RESUME=1 FAKE_NOW=$((E0 + 4 * P)) "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1; then fail "roll resumed nothing"; fi
grep -q "no interrupted broadcast" "$T/out" || fail "roll RESUME refusal unexplained"
grep -q '^forge' "$CALLS" && fail "forge ran on a refused roll RESUME"
: > "$CALLS"
if FAKE_FAIL=Seed.run FAKE_NOW=$((E0 + 4 * P)) "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1; then fail "failing roll seed passed"; fi
grep -q "RESUME=1 $SCR/roll-testnet.sh monad seed" "$T/out" || fail "roll hint does not name the seed step"
before=$(jexp)
: > "$CALLS"
RESUME=1 FAKE_NOW=$((E0 + 4 * P)) "$SCR/roll-testnet.sh" monad seed > "$T/out" 2>&1 || fail "roll RESUME=1 seed failed"
expect_seq "Seed.run! sdk cre:monad-testnet" "RESUME=1 roll-testnet.sh monad seed"
[ "$(jexp)" = "$before" ] || fail "resumed seed changed the expiry"

# collect is broadcast as collect-latest.json (--sig "collect()"): RESUME=1 finds that one, then later steps run afresh
: > "$CALLS"
if FAKE_FAIL=Seed.collect FAKE_NOW=$((E0 + 4 * P)) "$SCR/roll-testnet.sh" monad > "$T/out" 2>&1; then fail "failing collect passed"; fi
grep -q "RESUME=1 $SCR/roll-testnet.sh monad collect" "$T/out" || fail "roll hint does not name collect"
rm -f "$T/root/contracts/broadcast/Seed.s.sol/10143/run-latest.json"
: > "$CALLS"
RESUME=1 FAKE_NOW=$((E0 + 4 * P)) FAKE_NEXT=$((E0 + 6 * P)) "$SCR/roll-testnet.sh" monad collect > "$T/out" 2>&1 \
  || fail "roll RESUME=1 collect failed"
expect_seq "Seed.collect! fund CreatePools.run Seed.run sdk cre:monad-testnet" "RESUME=1 roll-testnet.sh monad collect"

# a pools attempt that failed before broadcasting leaves the previous (finished) run-latest.json: never replayed
touch -t 202001010000 "$T/root/contracts/broadcast/CreatePools.s.sol/10143/run-latest.json"
if FAKE_FAIL=CreatePools.run FAKE_NO_BROADCAST=1 FAKE_NOW=$((E0 + 6 * P - 1800)) "$SCR/roll-testnet.sh" monad pools \
  > "$T/out" 2>&1; then fail "failing pools passed"; fi
: > "$CALLS"
if RESUME=1 FAKE_NOW=$((E0 + 6 * P - 1800)) "$SCR/roll-testnet.sh" monad pools > "$T/out" 2>&1; then
  fail "resumed an old CreatePools broadcast"
fi
grep -q '^forge' "$CALLS" && fail "forge replayed an old broadcast"

# RESUME=1 on pools resumes the interrupted broadcast without planning an expiry again (forge --resume does not
# simulate): no grid read, no wait and no NO_WAIT stop even when the next expiry is not listable yet, and the
# deployments file gets the expiry the interrupted attempt planned
: > "$CALLS"
if FAKE_FAIL=CreatePools.run FAKE_NOW=$((E0 + 6 * P - 1800)) "$SCR/roll-testnet.sh" monad pools > "$T/out" 2>&1; then
  fail "failing pools passed"
fi
planned=$((E0 + 8 * P))
grep -q "EXPIRY=$planned " <<<"$(grep '^forge CreatePools.run resume=0' "$CALLS")" || fail "interrupted pools: wrong plan"
: > "$CALLS"
RESUME=1 NO_WAIT=1 FAKE_NOW=$((E0 + 2 * P)) "$SCR/roll-testnet.sh" monad pools > "$T/out" 2>&1 \
  || fail "RESUME=1 roll-testnet.sh monad pools did not resume"
expect_seq "CreatePools.run! Seed.run sdk cre:monad-testnet" "RESUME=1 roll-testnet.sh monad pools"
grep -q "EXPIRY= " <<<"$(forge_line CreatePools.run)" || fail "resumed pools planned an expiry"
grep -q 'grid()' "$CALLS" && fail "resumed pools read the grid"
[ "$(jexp)" = $planned ] || fail "resumed pools: not the interrupted attempt's expiry"

# a lead just above the quarter period CreatePools enforces is treated as late (CreatePools checks it again while
# simulating, seconds later): the plan keeps a two-minute margin
: > "$CALLS"
FAKE_NOW=$((planned + P - P / 4 - 60)) FAKE_NEXT=$((planned + 2 * P)) "$SCR/roll-testnet.sh" monad pools > "$T/out" 2>&1 \
  || fail "roll at the quarter-period margin failed"
grep -q "WARNING: late roll" "$T/out" || fail "lead within the margin not treated as late"
grep -q "EXPIRY= " <<<"$(forge_line CreatePools.run)" || fail "lead within the margin still forced the expiry"
: > "$CALLS"
FAKE_NOW=$((planned + 3 * P - P / 4 - 180)) "$SCR/roll-testnet.sh" monad pools > "$T/out" 2>&1 \
  || fail "roll just outside the margin failed"
grep -q "EXPIRY=$((planned + 3 * P)) " <<<"$(forge_line CreatePools.run)" || fail "lead outside the margin not opened"

# inside the margin CreatePools may still open the consecutive expiry (lead >= a quarter period): then the chain is
# kept and nothing claims it broke
: > "$CALLS"
FAKE_NOW=$((planned + 4 * P - P / 4 - 60)) FAKE_NEXT=$((planned + 4 * P)) "$SCR/roll-testnet.sh" monad pools \
  > "$T/out" 2>&1 || fail "late roll that keeps the chain failed"
grep -q "WARNING: late roll" "$T/out" || fail "margin roll not warned"
grep -q "chain broken" "$T/out" && fail "chain reported broken although the consecutive expiry opened"
grep -q "3 consecutive expiries" "$T/out" || fail "consecutive count not continued: $(grep consecutive "$T/out")"

# HyperEVM roll: a deployment opened before the extra pair existed gets it on the next roll (the chain's default from
# scripts/lib/testnet.sh); once recorded in .pools, later rolls take it from there like the launch tokens
python3 - "$DEP/hyperevm-testnet.json" "$E0" <<'PY'
import json, sys
f, e = sys.argv[1], int(sys.argv[2])
json.dump({"chainId": 998, "confluere": "0x00000000000000000000000000000000000000c0", "gridPeriod": 3600, "deployBlock": 1,
           "pools": {"lst": "0x0000000000000000000000000000000000000000", "native": "0x5555555555555555555555555555555555555555",
                     "usdc": "0x2B3370eE501B4a559b57D449569354196457D8Ab", "expiry": e, "poolIds": ["0x%064x" % e]}},
          open(f, "w"))
PY
: > "$CALLS"
FAKE_NOW=$((E0 - 1800)) "$SCR/roll-testnet.sh" hyperevm > "$T/out" 2>&1 || fail "hyperevm roll failed"
expect_seq "Seed.collect fund CreatePools.run Seed.run sdk" "roll-testnet.sh hyperevm"
grep -q "EXTRA=0x2B3370eE501B4a559b57D449569354196457D8Ab XQ=0x5555555555555555555555555555555555555555 " \
  <<<"$(forge_line CreatePools.run)" || fail "hyperevm roll without the extra pair"
grep -q 'BPS=10 .*XBPS=2000' <<<"$(forge_line Seed.run)" || fail "hyperevm roll seed sizes"
grep -q '"extraAsset"' "$DEP/hyperevm-testnet.json" || fail "extra pair not recorded by the roll"
XO=0x00000000000000000000000000000000000000e3 # another extra asset already recorded: the record wins over the default
python3 - "$DEP/hyperevm-testnet.json" "$XO" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["pools"]["extraAsset"] = sys.argv[2]; json.dump(d, open(sys.argv[1], "w"))
PY
: > "$CALLS"
FAKE_NOW=$((E0 - 1700)) "$SCR/roll-testnet.sh" hyperevm > "$T/out" 2>&1 || fail "second hyperevm roll failed"
grep -q "EXTRA=$XO " <<<"$(forge_line CreatePools.run)" || fail "roll ignored the recorded extra pair"

# ---------------------------------------------------------------- Sepolia
SW=0xB82381A3fBD3FaFA77B3a7bE693342618240067b SE=0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
SU=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
rm -rf "$DEP/.staging" "$T/state"/*
# preflight, book layout, one expiry, 3 trade rounds (10 sells and 10 buys of one unit per strike): wstETH/WETH at
# 0.0012 wstETH, K 0.93 WETH: 10 x (1.116e15 + 1000) WETH and 10 x 1.2e15 wstETH; WETH/USDC at 0.0001 WETH, K 2100:
# 10 x (210000 + 1000) USDC and 10 x 1e14 WETH; wstETH/USDC at 0.0001 wstETH, K 2200: 10 x (220000 + 1000) USDC and
# 10 x 1e14 wstETH. wstETH, WETH and USDC are each counted once.
: > "$CALLS"
TRADE_ROUNDS=3 LIBCHAIN=sepolia lib 'preflight' > "$T/out" 2>&1 || fail "sepolia preflight failed when funded"
grep -qE "lst +need 13000000000000000 " "$T/out" || fail "Sepolia wstETH need: $(grep lst "$T/out")"
grep -qE "native +need 12160000000010000 " "$T/out" || fail "Sepolia WETH need: $(grep native "$T/out")"
grep -qE "usdc +need 4320000 " "$T/out" || fail "Sepolia USDC need: $(grep usdc "$T/out")"
grep -qE "^  extra" "$T/out" && fail "Sepolia: the extra pair's tokens (wstETH, USDC) were counted as separate tokens"
grep -q "balanceOf(address)(uint256)" <<<"$(grep "$SW" "$CALLS")" || fail "Sepolia preflight did not read wstETH"
# no USDC: a clear stop naming the Circle faucet; FUND=1 stakes the missing wstETH (ETH sent to wstETH, at its rate
# plus 1 gwei) and wraps the missing WETH, and keeps GAS_RESERVE (Sepolia default 0.05 ETH) for gas
: > "$CALLS"
if TRADE_ROUNDS=3 LIBCHAIN=sepolia FAKE_BAL=0 FAKE_GAS=2000000000000000000 FUND=1 lib 'preflight' > "$T/out" 2>&1; then
  fail "sepolia preflight passed without USDC"
fi
grep -q "faucet.circle.com" "$T/out" || fail "Sepolia: no USDC faucet hint"
grep -q "cast send $SW --value 1037717826760305089 " "$CALLS" || fail "FUND=1 did not stake wstETH: $(grep 'cast send' "$CALLS")"
grep -q "cast send $SE deposit() --value 12160000000010000 " "$CALLS" || fail "FUND=1 did not wrap WETH"
# enough native coin to stake but not to wrap as well: the wrap would eat into the gas reserve, so it stops there
: > "$CALLS"
if TRADE_ROUNDS=3 LIBCHAIN=sepolia FAKE_BAL=0 FAKE_GAS=1095000000000000000 FUND=1 lib 'preflight' > "$T/out" 2>&1; then
  fail "sepolia preflight passed short"
fi
grep -q "cast send $SW" "$CALLS" || fail "FUND=1 did not stake wstETH with enough ETH"
grep -q "cast send $SE" "$CALLS" && fail "FUND=1 wrapped WETH into the gas reserve after staking"
grep -q "short of wrapped native" "$T/out" || fail "no WETH hint once the reserve is reached"
: > "$CALLS"
if TRADE_ROUNDS=3 LIBCHAIN=sepolia FAKE_BAL=0 FAKE_GAS=1000000000000000000 FUND=1 lib 'preflight' > "$T/out" 2>&1; then
  fail "sepolia preflight passed short"
fi
grep -q "cast send $SW" "$CALLS" && fail "FUND=1 staked into the gas reserve"
grep -q "short of LST $SW by .*receive() stakes and wraps" "$T/out" || fail "no wstETH hint: $(grep LST "$T/out")"

# deploy-testnet.sh sepolia: no big blocks, the seven-row salt (not the live testnets' 0xc0f2), its GRAD row, the
# wstETH/USDC extra pair, its own seed units, its own CRE config
: > "$CALLS"
"$SCR/deploy-testnet.sh" sepolia > "$T/out" 2>&1 || fail "deploy-testnet.sh sepolia failed"
expect_seq "Deploy.run fund CreatePools.run Seed.run CreateVaults.run DeployPositionMarket.run DeploySeatLP.run sdk cre:sepolia" \
  "deploy-testnet.sh sepolia"
# PositionMarket and the SeatLP tokens go on the core's own salt (the scripts' default 0xc0f1 is no testnet core's)
for k in DeployPositionMarket.run DeploySeatLP.run; do
  grep -q "SALT=0x0*c0f3 " <<<"$(forge_line $k)" || fail "Sepolia $k: $(forge_line $k)"
done
grep -q '"positionMarket"' "$DEP/sepolia.json" && grep -q '"seatLPTokens"' "$DEP/sepolia.json" \
  || fail "Sepolia PositionMarket / SeatLP tokens not recorded"
grep -q "SALT=0x0*c0f3 GRAD=sepolia" <<<"$(forge_line Deploy.run)" || fail "Sepolia deploy: $(forge_line Deploy.run)"
grep -q "NATIVE=$SE .*EXTRA=$SW XQ=$SU " <<<"$(forge_line CreatePools.run)" || fail "Sepolia pools: $(forge_line CreatePools.run)"
grep -q 'BPS=1 .*XBPS=1 LBPS=12 ' <<<"$(forge_line Seed.run)" || fail "Sepolia seed units: $(forge_line Seed.run)"
# forge's local simulation does not know Sepolia's state-creation gas: every Sepolia step takes the node's estimates
grep '^forge ' "$CALLS" | grep -q 'sim=1' && fail "a Sepolia step kept forge's local gas simulation"
[ "$(python3 -c "import json;print(json.load(open('$DEP/sepolia.json'))['chainId'])")" = 11155111 ] \
  || fail "deployments/sepolia.json not written"
grep -q '"nativeLend"' "$DEP/sepolia.json" && fail "Sepolia records a native-coin lending vault (its extra pair lends USDC)"
# the live testnets keep their salt, and every chain's Deploy carries the Sepolia GRAD row (one table everywhere)
: > "$CALLS"
FAKE_BLOCK=40 UNTIL=deploy "$SCR/deploy-testnet.sh" monad > "$T/out" 2>&1 || fail "monad deploy step failed"
grep -q "SALT=0x0*c0f2 GRAD=sepolia" <<<"$(forge_line Deploy.run)" || fail "Monad deploy: $(forge_line Deploy.run)"
# a bad chain name prints the usage naming all three
if "$SCR/deploy-testnet.sh" goerli > "$T/out" 2>&1; then fail "unknown chain accepted"; fi
grep -q "monad|hyperevm|sepolia" "$T/out" || fail "deploy usage does not name sepolia"
if "$SCR/roll-testnet.sh" goerli > "$T/out" 2>&1; then fail "unknown chain accepted by the roll"; fi
grep -q "monad|hyperevm|sepolia" "$T/out" || fail "roll usage does not name sepolia"

# the Sepolia CRE config is its own file, scanned through sync-config's archive RPC unless SEPOLIA_LOGS_RPC is set
: > "$CALLS"
"$SCR/deploy-testnet.sh" sepolia vaults > "$T/out" 2>&1 || fail "sepolia vaults step failed"
grep -q "DEPLOYMENT=sepolia CRE_CONFIG=config.sepolia.json RPC= .*sync-config" "$CALLS" \
  || fail "Sepolia CRE sync not on config.sepolia.json with sync-config's own RPC"
: > "$CALLS"
SEPOLIA_LOGS_RPC=http://archive.example "$SCR/deploy-testnet.sh" sepolia vaults > "$T/out" 2>&1 || fail "sepolia vaults step failed"
expect_seq "CreateVaults.run DeployPositionMarket.run DeploySeatLP.run sdk cre:sepolia" "Sepolia CRE sync"
grep -q "RPC=http://archive.example .*sync-config" "$CALLS" || fail "SEPOLIA_LOGS_RPC not passed to sync-config"
# a run that stopped after vaults finishes with the market step alone
: > "$CALLS"
"$SCR/deploy-testnet.sh" sepolia market > "$T/out" 2>&1 || fail "sepolia market step failed"
expect_seq "DeployPositionMarket.run DeploySeatLP.run sdk cre:sepolia" "deploy-testnet.sh sepolia market"

# roll-testnet.sh sepolia: tokens from .pools, the next consecutive expiry, its own state files
python3 - "$DEP/sepolia.json" "$E0" "$SW" "$SE" "$SU" <<'PY'
import json, sys
f, e, sw, se, su = sys.argv[1], int(sys.argv[2]), *sys.argv[3:6]
d = {"chainId": 11155111, "confluere": "0x00000000000000000000000000000000000000c0", "gridPeriod": 3600, "deployBlock": 1,
     "pools": {"lst": sw, "native": se, "usdc": su, "expiry": e, "extraAsset": sw, "extraQuote": su,
               "poolIds": ["0x%064x" % e]}}
json.dump(d, open(f, "w"))
PY
: > "$CALLS"
FAKE_NOW=$((E0 - 1800)) "$SCR/roll-testnet.sh" sepolia > "$T/out" 2>&1 || fail "sepolia roll failed"
expect_seq "Seed.collect fund CreatePools.run Seed.run sdk cre:sepolia" "roll-testnet.sh sepolia"
grep -q "EXPIRY=$((E0 + P)) NATIVE=$SE .*EXTRA=$SW XQ=$SU " <<<"$(forge_line CreatePools.run)" || fail "sepolia roll pools"
[ -f "$T/state/confluere/roll-sepolia-0x00000000000000000000000000000000000000c0.txt" ] || fail "sepolia roll state"

echo "testnet-lib tests OK"
