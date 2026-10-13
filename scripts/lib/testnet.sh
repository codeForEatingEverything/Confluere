# Shared by scripts/deploy-testnet.sh and scripts/roll-testnet.sh (sourced, not run). Expects ROOT and the chain
# name (monad | hyperevm) as $1 of testnet_env; works from $ROOT/contracts.
#
# Real tokens (verified on-chain 2026-10-12):
#   Monad testnet:    WMON 0xFb8b…C541 (deposit() wraps MON), USDC 0x534b…43A3 (Circle faucet),
#                     shMON 0x282B…45C9 (FastLane, deposit(assets, receiver) payable; 1 shMON ≈ 12.9 MON)
#   HyperEVM testnet: WHYPE 0x5555…5555 (deposit()), USDC 0x2B33…D8Ab (Circle faucet). No mintable LST, so no loop pair;
#                     instead the extra pair USDC/WHYPE (borrowers post USDC for HYPE) is how the native coin is lent.

export PATH="$PATH:$HOME/.foundry/bin"
M_WMON=0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541
M_USDC=0x534b2f3A21130d7a60830c2Df862319e593943A3
M_SHMON=0x282BdDFF5e58793AcAb65438b257Dbd15A8745C9
H_WHYPE=0x5555555555555555555555555555555555555555
H_USDC=0x2B3370eE501B4a559b57D449569354196457D8Ab
ZERO=0x0000000000000000000000000000000000000000
LOG=$(mktemp "${TMPDIR:-/tmp}/confluere-step.XXXXXX")
BIG=0 # 1 while HyperEVM big blocks may be on for this account
SEED_TTL=48 # Seed.s.sol _p: p.ttl of every seeded order (scripts/test/testnet-lib.test.sh checks the two agree)

# Chain parameters without touching the network: RPC, strikes, the deployments file, HyperEVM's gas flags. Tokens
# default to the real ones above. scripts/test/grad-seed.test.sh reads them too.
testnet_params() {
  CHAIN=$1
  case "$CHAIN" in
    monad)
      R=https://testnet-rpc.monad.xyz
      NAME=monad-testnet
      export LST=$M_SHMON NATIVE=$M_WMON USDC=$M_USDC
      export LST_STRIKE_HIGH=12000000000000000000 LST_STRIKE_LOW=11000000000000000000 # ~93% / 85% of 12.9 MON
      export USD_STRIKE_LOW=25000 USD_STRIKE_HIGH=26000                              # MON ≈ 0.027 USDC (Kuru mid)
      # Extra pair shMON/USDC (every pair of MON/WMON/shMON/USDC that can be a market). Priced at the
      # normal market price: shMON ≈ 1 MON ≈ 0.0248 USDC (Kuru MON_USDC mid; the testnet shMON contract's 12.9 MON
      # redemption rate is a testnet artefact, not a price). Buy-back prices 0.021 / 0.023 USDC (~86% / 92%).
      export EXTRA_ASSET=$M_SHMON EXTRA_QUOTE=$M_USDC EXTRA_BAND=800
      export EXTRA_STRIKE_LOW=21000 EXTRA_STRIKE_HIGH=23000
      export EXTRA_SEED_UNIT_BPS=${EXTRA_SEED_UNIT_BPS:-48} # 0.0048 shMON x 0.021 USDC clears the core's 0.0001 USDC minimum order
      EXTRA=()
      ;;
    hyperevm)
      R=${HYPEREVM_RPC:-https://rpc.hyperliquid-testnet.xyz/evm} # rate-limited per IP; HYPEREVM_RPC=https://rpcs.chain.link/hyperevm/testnet also works
      NAME=hyperevm-testnet
      export NATIVE=$H_WHYPE USDC=$H_USDC LST=$ZERO
      export USD_STRIKE_LOW=25000000 USD_STRIKE_HIGH=27000000 # HYPE ≈ 29.1 USDC on HyperCore testnet (2026-10-13): ~86% / 93%
      # Extra pair USDC/WHYPE (CreatePools EXTRA_*): lends the native coin against USDC, as shMON/WMON does on Monad.
      # Strikes in WHYPE per USDC on the 2-digit grid: 0.028 / 0.030 (HYPE ≈ 29.1 USDC on HyperCore spot, 1/HYPE ≈
      # 0.0343: about 82% / 87% of the collateral's value). 8% band like the USD pools (not pegged). The quote is WHYPE,
      # whose graduation row (0.1 WHYPE per market and expiry) needs 0.32 USDC seed units: 24 x 0.32 = 7.7 USDC per roll,
      # locked until that expiry closes (scripts/test/grad-seed.test.sh checks one seed clears the row).
      export EXTRA_ASSET=$H_USDC EXTRA_QUOTE=$H_WHYPE EXTRA_BAND=800
      export EXTRA_STRIKE_LOW=28000000000000000 EXTRA_STRIKE_HIGH=30000000000000000
      export EXTRA_SEED_UNIT_BPS=${EXTRA_SEED_UNIT_BPS:-3200}
      EXTRA=(--disable-block-gas-limit)                       # big blocks toggled per step
      export FOUNDRY_GAS_LIMIT=30000000
      ;;
    *) return 1 ;;
  esac
  J="$ROOT/deployments/$NAME.json"
  STAGE_DIR="$ROOT/deployments/.staging"
}

# Signer flags. The deployer key never goes on a command line (it would show in `ps`): the encrypted keystore
# ~/.foundry/keystores/confluere-deployer with its password file contracts/.keystore-password is used when present;
# the raw PRIVATE_KEY is only the fallback for the offline tests' fake key.
signer_args() {
  local acct=${KEYSTORE_ACCOUNT:-confluere-deployer}
  if [ -f "$HOME/.foundry/keystores/$acct" ] && [ -f "$ROOT/contracts/.keystore-password" ]; then
    SIGNER=(--account "$acct" --password-file "$ROOT/contracts/.keystore-password")
  else
    SIGNER=(--private-key "$PRIVATE_KEY")
  fi
}

testnet_env() {
  testnet_params "$1" || return 1
  signer_args
  FS=(--rpc-url "$R" "${SIGNER[@]}" --broadcast --slow --non-interactive ${EXTRA[@]+"${EXTRA[@]}"})
  CHAIN_ID=$(rcast chain-id --rpc-url "$R")
}

# The graduation / order-minimum rows of both testnets (Deploy.s.sol GRAD_<chainId>):
# quote:graduationVolume:minNotional:seatObligation, small testnet values (USDC min order 0.0001, native 0.001).
# Graduation needs this volume in each of four consecutive expiries: 0.001 USDC and 0.1 native, so the small seeds of
# scripts/roll-testnet.sh (SEED_UNIT_BPS=100) graduate a market and let the vaults invest; scripts/test/grad-seed.test.sh
# checks one seed clears them. The whole table is part of the core's init code (both chains carry every row, so they
# share one core address): changing any value here and redeploying gives a NEW core address on both chains; redeploy
# both and regenerate the SDK and CRE configs (scripts/deploy-testnet.sh does).
testnet_grad() {
  export GRAD_10143="$M_WMON:100000000000000000:1000000000000000:100000000000000000,$M_USDC:1000:100:100000"
  export GRAD_998="$H_WHYPE:100000000000000000:1000000000000000:100000000000000000,$H_USDC:1000:100:100000"
}

# File mtime in seconds: GNU stat (Linux) first, BSD stat (macOS) second.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# timeout(1) is GNU coreutils: plain macOS has none (Homebrew installs gtimeout); run without a limit there.
with_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"
  else shift; "$@"; fi
}

# jget FILE PATH: one value from a JSON file ("pools.native"), empty when missing.
jget() {
  python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else (" ".join(d) if isinstance(d, list) else d))
PY
}

# After a broadcast: every address the staged file names must have code and every pool id must exist on chain,
# before the file replaces deployments/<chain>.json. A read that still fails after rcast's retries fails the check
# (an unreadable chain proves nothing landed), as does a pool() answer too short to hold the status word.
verify_stage() {
  local f=$1 a id core raw code status
  for a in $(python3 - "$f" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
keys = ["confluere", "router", "wrapperFactory", "vaultFactory", "keeperReceiver", "seatRegistry"]
out = [d[k] for k in keys if k in d] + [v for v in (d.get("vaults") or {}).values()]
print(" ".join(a for a in out if int(a, 16) != 0))
PY
  ); do
    code=$(rcast code "$a" --rpc-url "$R") || { echo "verify: cannot read the code at $a"; return 1; }
    [ -n "$code" ] && [ "$code" != "0x" ] || { echo "verify: no code at $a"; return 1; }
  done
  core=$(jget "$f" confluere)
  for id in $(jget "$f" pools.poolIds); do
    raw=$(rcast call "$core" "pool(bytes32)" "$id" --rpc-url "$R") || { echo "verify: cannot read pool $id"; return 1; }
    # PoolView starts with the 5-word key, then the status word (0 = None)
    [ "${#raw}" -ge $((2 + 64 * 6)) ] || { echo "verify: short pool() answer for $id"; return 1; }
    status=$(python3 -c "import sys; print(int(sys.argv[1][2+64*5:2+64*6], 16))" "$raw") \
      || { echo "verify: unreadable pool() answer for $id"; return 1; }
    [ "$status" != 0 ] || { echo "verify: pool $id missing"; return 1; }
  done
}

# keep_records STAGE: a Deploy re-run rewrites the whole deployments file (Deploy.s.sol _write) and so leaves out the
# .pools, .vaults and .positionMarket that later steps recorded. When the staged file names the same core as deployments/<chain>.json,
# those records still describe live contracts of that core: copy them back into the stage (they are verified with it).
# A stage that names another core starts empty, as it should.
keep_records() {
  [ -f "$J" ] && [ -f "$1" ] || return 0
  python3 - "$J" "$1" <<'PY'
import json, sys
old, new = (json.load(open(f)) for f in sys.argv[1:3])
if str(old.get("confluere", "")).lower() == str(new.get("confluere", "")).lower() != "":
    kept = [k for k in ("pools", "vaults", "positionMarket") if k in old and k not in new]
    for k in kept:
        new[k] = old[k]
    if kept:
        json.dump(new, open(sys.argv[2], "w"), indent=2)
        print("kept " + " and ".join(kept) + " of the same core")
PY
}

# The staging dir (deployments/.staging) holds a step's staged JSON and the start time of its last attempt while it
# has not finished; its own .gitignore keeps it out of git. Removed once nothing is pending.
stage_dir() { mkdir -p "$STAGE_DIR"; [ -f "$STAGE_DIR/.gitignore" ] || printf '*\n' > "$STAGE_DIR/.gitignore"; }
stage_tidy() {
  if [ -d "$STAGE_DIR" ] && [ "$(ls -A "$STAGE_DIR")" = .gitignore ]; then rm -rf "$STAGE_DIR"; fi
  return 0
}

# run NAME SCRIPT WRITES_JSON [forge args...]
# Public testnet RPCs drop connections now and then: retry a failed step (resuming its broadcast), stop on the third
# failure instead of running later steps against a half-finished deployment. forge writes deployments JSON while it
# simulates, before anything is broadcast, so a step that writes JSON works on a staging copy that replaces
# deployments/<chain>.json only after the broadcast finished and the chain shows its contracts and pools.
# forge keeps the broadcast of `--sig "f()"` in broadcast/<script>/<chainId>/f-latest.json (run-latest.json for run()).
# RESUME=1 resumes that broadcast on the first try, with the step's staged JSON, but only when it was written by the
# step's last (failed) attempt: an attempt that failed before broadcasting leaves the previous run's file, and
# resuming that would replay an old, finished sequence. The caller sets STEP for the hint printed on failure.
run() {
  local name=$1 script=$2 writes=$3; shift 3
  local sig=run prev="" a
  for a in "$@"; do
    if [ "$prev" = --sig ]; then sig=${a%%(*}; fi
    prev=$a
  done
  local base key
  base=$(basename "$script" .s.sol)
  key=$base
  [ "$sig" = run ] || key="$base.$sig"
  local latest="broadcast/$(basename "$script")/$CHAIN_ID/$sig-latest.json"
  local stage="$STAGE_DIR/$NAME.$key.json" mark="$STAGE_DIR/$NAME.$key.since"
  local since resume_first=0
  stage_dir
  if [ "${RESUME:-0}" = 1 ]; then
    if [ -f "$mark" ] && [ -f "$latest" ] && [ "$(mtime "$latest")" -ge "$(cat "$mark")" ]; then
      resume_first=1
      since=$(cat "$mark")
    else
      echo "RESUME=1: '$name' has no interrupted broadcast to resume (its last attempt finished, or failed before"
      echo "broadcasting: contracts/$latest is missing or older). Run the same command without RESUME=1."
      exit 1
    fi
  else
    since=$(date +%s)
    echo "$since" > "$mark"
  fi
  if [ "$writes" = 1 ]; then
    if [ "$resume_first" = 1 ] && [ -f "$stage" ]; then
      : # the interrupted broadcast's own staged JSON
    elif [ "$base" = Deploy ] && [ -f "$stage" ]; then
      : # a failed Deploy attempt's file names the same CREATE2 core and keeps its deploy block (log-scan start)
    elif [ -f "$J" ]; then cp "$J" "$stage"
    else rm -f "$stage"; fi
    export DEPLOYMENTS_FILE="$stage"
    # a kept stage may name another core (an attempt with other GRAD rows): Deploy then takes the block from $J
    if [ "$base" = Deploy ] && [ -f "$J" ]; then export DEPLOYMENTS_FALLBACK="$J"; fi
  fi
  for try in 1 2 3; do
    echo; echo "== $name (try $try)"
    # resume only a broadcast this step itself started (or RESUME=1 asked for); never replay an older one
    local resume=()
    if [ "$try" = 1 ] && [ "$resume_first" = 1 ]; then resume=(--resume)
    elif [ "$try" -gt 1 ] && [ -f "$latest" ] && [ "$(mtime "$latest")" -ge "$since" ]; then resume=(--resume); fi
    if forge script "$script" "${FS[@]}" ${resume[@]+"${resume[@]}"} "$@" > "$LOG" 2>&1; then
      grep -E "Confluere 0x|pools created|seeded|vaults|collected|ONCHAIN" "$LOG" || true
      if [ "$writes" = 1 ]; then
        if [ "$base" = Deploy ]; then keep_records "$stage" || { echo "FAILED: could not merge records"; exit 1; }; fi
        verify_stage "$stage" || { echo "FAILED: $name broadcast did not land; deployments/$NAME.json left unchanged"; exit 1; }
        mv "$stage" "$J"
        unset DEPLOYMENTS_FILE
      fi
      rm -f "$mark"
      stage_tidy
      return 0
    fi
    grep -E "Error|error" "$LOG" | head -3
    sleep "${RETRY_SLEEP:-10}"
  done
  echo "FAILED: $name. deployments/$NAME.json is unchanged. To finish this broadcast:"
  echo "  RESUME=1 $0 $CHAIN ${STEP:-}"
  echo "or run that command without RESUME=1 to simulate the step afresh (finished parts are skipped)."
  exit 1
}

# HyperEVM: the core, VaultFactory and each Vault exceed the 3M small-block limit, so those steps run in big blocks
# (one per minute); pools and orders go back to 1 s small blocks. The EXIT trap below switches them off on any exit.
_bigblocks_try() {
  local try
  for try in 1 2 3; do
    (cd "$ROOT" && with_timeout 60 pnpm --filter @confluere/ops -s big-blocks "$1" 2>&1 | grep -q '"ok"') && return 0
    sleep "${RETRY_SLEEP:-10}"
  done
  return 1
}
bigblocks() {
  [ "$CHAIN" = hyperevm ] || return 0
  [ "$1" = on ] && BIG=1 # set first: a timed-out "on" may still have landed
  _bigblocks_try "$1" || { echo "FAILED: big-blocks $1"; exit 1; }
  [ "$1" = off ] && BIG=0
  return 0
}
testnet_cleanup() {
  if [ "$BIG" = 1 ]; then
    echo "switching HyperEVM big blocks off"
    _bigblocks_try off && BIG=0 || echo "WARNING: big blocks may still be on: pnpm --filter @confluere/ops big-blocks off"
  fi
  rm -f "$LOG"
}
trap testnet_cleanup EXIT
trap 'exit 130' INT TERM

# preflight: the deployer's balances must cover one seed of every launch pool and of the extra pair, if any (Seed.s.sol
# _seedPool: per pool 1+2+3 units sold, and the same units bought at 97/98/99% of K; the extra pair at
# EXTRA_SEED_UNIT_BPS), summed per token, before any pool is created, so a short wallet stops here and not halfway.
# Each buy escrows exactly what the core's placeOrder pulls (OrderLogic, BUY):
# quoteUp(units * limit) + ttl, i.e. the quote rounded up per order plus 1 wei per batch of its ttl (SEED_TTL below).
# FUND=1 wraps the missing wrapped-native amount from the native balance (deposit()); USDC and shMON must be
# obtained by hand (Circle faucet; FastLane deposit). GAS_RESERVE (wei, default 0.5 native) stays unwrapped for gas.
# Public testnet RPCs drop connections now and then (HyperEVM: "tls handshake eof"): retry a read a few times before
# giving up, so a flaky read does not stop a deployment between steps.
rcast() {
  local out i
  for i in 1 2 3 4 5; do
    if out=$(cast "$@" 2>/dev/null); then echo "$out"; return 0; fi
    sleep 3
  done
  cast "$@"
}

preflight() {
  local bps=${SEED_UNIT_BPS:-100} me
  local xbps=${EXTRA_SEED_UNIT_BPS:-$bps} xa=${EXTRA_ASSET:-$ZERO}
  signer_args
  me=$(cast wallet address "${SIGNER[@]}")
  dec() { rcast call "$1" "decimals()(uint8)" --rpc-url "$R" | awk '{print $1}'; }
  bal() { rcast call "$1" "balanceOf(address)(uint256)" "$me" --rpc-url "$R" | awk '{print $1}'; }
  # every token the seed touches, once: label=address=decimals=balance (the launch tokens keep their labels; the
  # extra pair's tokens are usually among them, e.g. USDC/WHYPE on HyperEVM)
  local toks=() pairs=() seen=" " t a lbl
  for t in "lst=$LST" "native=$NATIVE" "usdc=$USDC" "extra-asset=$xa" "extra-quote=${EXTRA_QUOTE:-$ZERO}"; do
    lbl=${t%%=*}; a=${t#*=}
    [ "$(echo "$a" | tr A-F a-f)" != "$(echo "$ZERO" | tr A-F a-f)" ] || continue
    case "$seen" in *" $(echo "$a" | tr A-F a-f) "*) continue ;; esac
    seen="$seen$(echo "$a" | tr A-F a-f) "
    toks+=("$lbl=$a=$(dec "$a")=$(bal "$a")")
  done
  # pairs seeded: asset=quote=strikeLow=strikeHigh=bps (CreatePools order: loop pair, USD pair, extra pair)
  [ "$LST" = "$ZERO" ] || pairs+=("$LST=$NATIVE=${LST_STRIKE_LOW:-0}=${LST_STRIKE_HIGH:-0}=$bps")
  pairs+=("$NATIVE=$USDC=$USD_STRIKE_LOW=$USD_STRIKE_HIGH=$bps")
  [ "$xa" = "$ZERO" ] || pairs+=("$xa=$EXTRA_QUOTE=$EXTRA_STRIKE_LOW=$EXTRA_STRIKE_HIGH=$xbps")
  local plan
  plan=$(python3 - "$(rcast balance "$me" --rpc-url "$R")" "${GAS_RESERVE:-500000000000000000}" "$SEED_TTL" \
    "${toks[*]}" "${pairs[*]}" <<'PY'
import sys
gas, reserve, ttl, toks, pairs = sys.argv[1:]
ttl = int(ttl)
tok = {}  # lowercase address -> [label, decimals, balance, need]
order = []
for t in toks.split():
    lbl, a, d, b = t.split("=")
    tok[a.lower()] = [lbl, int(d), int(b), 0]
    order.append(a.lower())
for p in pairs.split():
    asset, quote, k1, k2, bps = p.split("=")
    d = tok[asset.lower()][1]
    u = 10 ** d * int(bps) // 10_000
    # Seed._seedPool per kind (2) and strike: sells of u*(j+1) (6 units), buys of u*(j+1) at K*(97+j)/100 for j = 0..2,
    # each escrowing quoteUp(units, limit, 10**d) + ttl (OrderLogic placeOrder, BUY)
    tok[asset.lower()][3] += 2 * 2 * 6 * u
    for k in (int(k1), int(k2)):
        for j in range(3):
            units, limit = u * (j + 1), k * (97 + j) // 100
            tok[quote.lower()][3] += 2 * (-(-units * limit // 10 ** d) + ttl)
labels = {tok[a][0] for a in order}
for lbl in ("lst", "native", "usdc"):  # the launch labels always print (lst 0 0 0 without an LST)
    if lbl not in labels:
        print(lbl, 0, 0, 0, "-")
for a in order:
    lbl, _, have, need = tok[a]
    print(lbl, need, have, max(0, need - have), a)
print("gas", int(reserve), int(gas), max(0, int(reserve) - int(gas)), "-")
PY
  )
  echo "$plan" | awk '{printf "  %-11s need %s have %s short %s\n", $1, $2, $3, $4}'
  local short_nat gas_have reserve
  short_nat=$(echo "$plan" | awk '$1=="native"{print $4}')
  gas_have=$(echo "$plan" | awk '$1=="gas"{print $3}')
  reserve=$(echo "$plan" | awk '$1=="gas"{print $2}')
  local fail=0 lbl need have short addr
  while read -r lbl need have short addr; do
    [ "$short" != 0 ] || continue
    case $lbl in
      native)
        if [ "${FUND:-0}" = 1 ] && python3 -c "import sys; sys.exit(0 if $gas_have - $short_nat >= $reserve else 1)"; then
          echo "  FUND=1: wrapping $short_nat wei into $NATIVE"
          cast send "$NATIVE" "deposit()" --value "$short_nat" --rpc-url "$R" "${SIGNER[@]}" >/dev/null </dev/null
        else
          echo "  short of wrapped native $NATIVE by $short_nat: cast send $NATIVE 'deposit()' --value $short_nat ..."
          echo "  (or re-run with FUND=1; it keeps GAS_RESERVE=$reserve wei of native for gas)"
          fail=1
        fi ;;
      usdc) echo "  short of USDC $USDC by $short (6 decimals): https://faucet.circle.com"; fail=1 ;;
      lst) echo "  short of LST $LST by $short: FastLane deposit(assets, receiver), ~12.9 MON per shMON"; fail=1 ;;
      gas) echo "  native balance below GAS_RESERVE for gas"; fail=1 ;;
      *) echo "  short of $lbl $addr by $short"; fail=1 ;;
    esac
  done <<<"$plan"
  if [ "$fail" = 1 ]; then
    [ "$xa" = "$ZERO" ] || bps="$bps (extra pair EXTRA_SEED_UNIT_BPS=$xbps)"
    echo "STOP: balances do not cover one seed at SEED_UNIT_BPS=$bps; nothing was created. Fund $me and re-run."
    exit 1
  fi
}

# Regenerate what reads deployments/*.json: SDK addresses and, on Monad, the CRE workflow config (receiver, vaults,
# live pools; the workflow targets monad-testnet only).
sync_offchain() {
  (cd "$ROOT/packages/sdk" && node scripts/sync-deployments.mjs && pnpm -s build)
  if [ "$CHAIN" = monad ]; then
    (cd "$ROOT" && DEPLOYMENT=monad-testnet RPC_URL="$R" pnpm --filter @confluere/keeper-cre -s sync-config)
  else
    echo "CRE config not touched: the workflow targets monad-testnet only"
  fi
}
