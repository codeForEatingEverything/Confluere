# Shared by scripts/deploy-testnet.sh and scripts/roll-testnet.sh (sourced, not run). Expects ROOT and the chain
# name (monad | hyperevm | sepolia) as $1 of testnet_env; works from $ROOT/contracts.
#
# Real tokens (verified on-chain 2026-10-12):
#   Monad testnet:    WMON 0xFb8b…C541 (deposit() wraps MON), USDC 0x534b…43A3 (Circle faucet),
#                     shMON 0x282B…45C9 (FastLane, deposit(assets, receiver) payable; 1 shMON ≈ 12.9 MON)
#   HyperEVM testnet: WHYPE 0x5555…5555 (deposit()), USDC 0x2B33…D8Ab (Circle faucet). No mintable LST, so no loop pair;
#                     instead the extra pair USDC/WHYPE (borrowers post USDC for HYPE) is how the native coin is lent.
# Verified 2026-10-23 (Sepolia reads and an anvil fork):
#   Ethereum Sepolia: WETH 0xfFf9…6B14 (Uniswap's canonical Sepolia WETH, deposit()), USDC 0x1c7D…7238 (Circle faucet),
#                     wstETH 0xB823…067b (Lido; sending ETH to it stakes and wraps in one call, 1 wstETH ≈ 1.0377 ETH),
#                     stETH 0x3e3F…40Af (submit(address) payable).

export PATH="$PATH:$HOME/.foundry/bin"
M_WMON=0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541
M_USDC=0x534b2f3A21130d7a60830c2Df862319e593943A3
M_SHMON=0x282BdDFF5e58793AcAb65438b257Dbd15A8745C9
H_WHYPE=0x5555555555555555555555555555555555555555
H_USDC=0x2B3370eE501B4a559b57D449569354196457D8Ab
S_WETH=0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14
S_USDC=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
S_WSTETH=0xB82381A3fBD3FaFA77B3a7bE693342618240067b
ZERO=0x0000000000000000000000000000000000000000
# CREATE2 salt of the testnet deployment (Deploy.s.sol SALT). The SeatRegistry's address does not depend on the grid,
# so a redeploy with the same GRAD rows but another grid needs a new salt (the registry of the old salt is bound to the
# old core). 0xc0f1: the 2026-10-12 demo-grid core; 0xc0f2: the 2026-10-13 daily-grid core.
# Adding the Ethereum and Sepolia rows (2026-10-23) changed the core's init code, so the core address of 0xc0f2 changed
# too, while the SeatRegistry addresses of Monad testnet and HyperEVM testnet did not: a Deploy re-run there on 0xc0f2
# would simulate a new core, then stop at "registry bound to another core" before broadcasting (the live 0x7E02…b1f7
# deployments stay as they are; their later steps and scripts/roll-testnet.sh do not run Deploy). So the seven-row
# table gets its own salt, TESTNET_SALT_NEXT (0xc0f3): Sepolia deploys on it now (testnet_params sets TESTNET_SALT for
# it), and Monad and HyperEVM move to it only when the founder approves their redeploy
# (SALT=$TESTNET_SALT_NEXT scripts/deploy-testnet.sh monad): with the same GRAD rows, deployer and grid all three then
# share one core address again. docs/IMPLEMENTATION_NOTES.md records this as a pending deviation.
TESTNET_SALT=0x000000000000000000000000000000000000000000000000000000000000c0f2
TESTNET_SALT_NEXT=0x000000000000000000000000000000000000000000000000000000000000c0f3
LOG=$(mktemp "${TMPDIR:-/tmp}/confluere-step.XXXXXX")
BIG=0 # 1 while HyperEVM big blocks may be on for this account
# Seeded books (Seed.s.sol book layout, SEED_APR_BPS > 0): priced by time to expiry at SEED_APR_BPS (10% a year), a
# resting lender bid and borrower ask SEED_SPREAD_BPS (default half the rate) either side, so anyone can borrow or lend
# at once; then TRADE_ROUNDS rounds of small crossing trades (the trade step) give each pool fills, a clearing price
# and a short price history. SEED_TTL: settlements each seeded order may rest (Seed.s.sol reads it; at most 1000).
export SEED_APR_BPS=${SEED_APR_BPS:-1000} SEED_TTL=${SEED_TTL:-1000}
TRADE_ROUNDS=${TRADE_ROUNDS:-3}
# Maturities opened at launch on the daily grid (GRID=daily, Deploy.s.sol): 1, 7 and 14 days (launch_expiries).
MATURITY_DAYS=${MATURITY_DAYS:-"1 7 14"}

# Chain parameters without touching the network: RPC, strikes, the deployments file, HyperEVM's gas flags. Tokens
# default to the real ones above. scripts/test/grad-seed.test.sh reads them too. LST_FUND=receive: sending native coin
# to the LST contract mints it (preflight's FUND=1 uses that); LST_HINT: how to get the LST by hand.
testnet_params() {
  CHAIN=$1
  LST_FUND="" LST_HINT=""
  case "$CHAIN" in
    monad)
      R=https://testnet-rpc.monad.xyz
      NAME=monad-testnet
      export LST=$M_SHMON NATIVE=$M_WMON USDC=$M_USDC
      # v0.8 strikes sit on the 1% log grid (Grid.strikeAt(n, quoteDecimals)): *_STRIKE_N is the canonical index the
      # core's createPool takes, *_STRIKE_LOW / HIGH the matching K (packages/sdk strikeAt gives the same values).
      # One buy-back price per pair (equal strikes: CreatePools opens a single strike), about 90% of the collateral's
      # normal market value on the 2-digit grid (2026-10-13): shMON ≈ 1 MON (the testnet shMON contract's 12.9 MON
      # redemption rate is a testnet artefact, not a price), MON ≈ 0.0249 USDC (Kuru MON_USDC mid).
      export LST_STRIKE_N=-11 LST_STRIKE_HIGH=896323717517805234 LST_STRIKE_LOW=896323717517805234 # 1.01^-11 ≈ 0.896 WMON per shMON
      export USD_STRIKE_N=-384 USD_STRIKE_LOW=21907 USD_STRIKE_HIGH=21907       # 1.01^-384 ≈ 0.0219 USDC per WMON (88%)
      # Extra pair shMON/USDC (every pair of MON/WMON/shMON/USDC that can be a market), same price as WMON/USDC.
      export EXTRA_ASSET=$M_SHMON EXTRA_QUOTE=$M_USDC EXTRA_BAND=800
      export EXTRA_STRIKE_N=-384 EXTRA_STRIKE_LOW=21907 EXTRA_STRIKE_HIGH=21907
      # Seed units: WMON/USDC 0.02 WMON (one seed plus the trade rounds clear the 0.001 USDC graduation row);
      # shMON/WMON 0.002 shMON and shMON/USDC 0.005 shMON, just above the 0.001 WMON / 0.0001 USDC order minimums
      # (the wallet holds little shMON; neither pair has to graduate)
      export SEED_UNIT_BPS=${SEED_UNIT_BPS:-200} LST_SEED_UNIT_BPS=${LST_SEED_UNIT_BPS:-20}
      export EXTRA_SEED_UNIT_BPS=${EXTRA_SEED_UNIT_BPS:-50}
      LST_HINT="FastLane deposit(assets, receiver), ~12.9 MON per shMON"
      EXTRA=()
      ;;
    hyperevm)
      R=${HYPEREVM_RPC:-https://rpc.hyperliquid-testnet.xyz/evm} # rate-limited per IP; HYPEREVM_RPC=https://rpcs.chain.link/hyperevm/testnet also works
      NAME=hyperevm-testnet
      export NATIVE=$H_WHYPE USDC=$H_USDC LST=$ZERO
      # One buy-back price per pair at about 90% of the normal market value: HYPE ≈ 83.1 USDC on HyperCore mainnet spot
      # (2026-10-13; the testnet book's ~29 is a testnet artefact): 75 USDC per WHYPE (90%).
      export USD_STRIKE_N=434 USD_STRIKE_LOW=75071695 USD_STRIKE_HIGH=75071695 # 1.01^434 ≈ 75.07 USDC
      # Extra pair USDC/WHYPE (CreatePools EXTRA_*): lends the native coin against USDC, as shMON/WMON does on Monad.
      # Strike in WHYPE per USDC: 0.011 (1 / 83.1 = 0.01204, so about 91%). 8% band like the USD pools (not pegged).
      export EXTRA_ASSET=$H_USDC EXTRA_QUOTE=$H_WHYPE EXTRA_BAND=800
      export EXTRA_STRIKE_N=-453 EXTRA_STRIKE_LOW=11025992086967947 EXTRA_STRIKE_HIGH=11025992086967947 # 1.01^-453 ≈ 0.01103 WHYPE
      # Seed units: WHYPE/USDC 0.001 WHYPE (clears the 0.001 USDC graduation row many times over); USDC/WHYPE 0.2 USDC,
      # above the 0.001 WHYPE order minimum (its 0.1 WHYPE graduation row would need ~2.3 USDC per order: not seeded)
      export SEED_UNIT_BPS=${SEED_UNIT_BPS:-10} EXTRA_SEED_UNIT_BPS=${EXTRA_SEED_UNIT_BPS:-2000}
      # Router.placeOrders batches (Seed.s.sol SEED_CHUNK) must fit a 3M-gas small block: 6 orders per transaction
      export SEED_CHUNK=${SEED_CHUNK:-6}
      EXTRA=(--disable-block-gas-limit)                       # big blocks toggled per step
      export FOUNDRY_GAS_LIMIT=30000000
      ;;
    sepolia)
      R=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com} # SEPOLIA_RPC=https://sepolia.drpc.org also works
      NAME=sepolia
      export LST=$S_WSTETH NATIVE=$S_WETH USDC=$S_USDC
      # The seven-row chain table's salt (see TESTNET_SALT above): a new core address, apart from the live testnets.
      TESTNET_SALT=$TESTNET_SALT_NEXT
      # One buy-back price per pair at about 90% of the collateral's normal market value on the 2-digit grid
      # (2026-10-23). wstETH is worth what it redeems for on this chain, 1.0377 ETH (stEthPerToken: unlike shMON's,
      # the Sepolia rate is what staking pays here): 0.93 WETH (90%). ETH ≈ 2375 USD (Ethereum mainnet Chainlink
      # ETH/USD; the Sepolia DEX books are testnet artefacts): 2100 USDC per WETH (88%).
      export LST_STRIKE_N=-7 LST_STRIKE_HIGH=932718054707135373 LST_STRIKE_LOW=932718054707135373 # 1.01^-7 ≈ 0.9327 WETH per wstETH
      export USD_STRIKE_N=769 USD_STRIKE_LOW=2104439470 USD_STRIKE_HIGH=2104439470 # 1.01^769 ≈ 2104 USDC per WETH
      # Extra pair wstETH/USDC (as shMON/USDC on Monad): 1.0377 x 2375 = 2465 USD, 2200 USDC per wstETH (89%).
      export EXTRA_ASSET=$S_WSTETH EXTRA_QUOTE=$S_USDC EXTRA_BAND=800
      export EXTRA_STRIKE_N=773 EXTRA_STRIKE_LOW=2189888152 EXTRA_STRIKE_HIGH=2189888152 # 1.01^773 ≈ 2190 USDC
      # Seed units, small because faucet Sepolia ETH and USDC are scarce: WETH/USDC and wstETH/USDC 0.0001 (the
      # smallest unit; ~0.21 USDC per order clears the 0.001 USDC graduation row many times over); wstETH/WETH
      # 0.0012 wstETH (0.00112 WETH at K, just above the 0.001 WETH order minimum; like shMON/WMON it need not
      # graduate). The launch run (3 expiries, 3 trade rounds) needs ~0.04 wstETH, ~0.04 WETH and ~13 USDC.
      export SEED_UNIT_BPS=${SEED_UNIT_BPS:-1} LST_SEED_UNIT_BPS=${LST_SEED_UNIT_BPS:-12}
      export EXTRA_SEED_UNIT_BPS=${EXTRA_SEED_UNIT_BPS:-1}
      # Router.placeOrders batches of 24 orders: ~10M gas each at Amsterdam's storage prices (48 took 20M on a fork).
      # Sepolia does take transactions above 2^24 gas (30M-limit transactions land, 2026-10-23); smaller batches just
      # lose less to a dropped one
      export SEED_CHUNK=${SEED_CHUNK:-24}
      # native ETH kept for gas by preflight's FUND=1 (pools, seed, trade rounds, vaults and later rolls)
      export GAS_RESERVE=${GAS_RESERVE:-50000000000000000}
      LST_FUND=receive
      LST_HINT="send Sepolia ETH to wstETH $S_WSTETH (its receive() stakes and wraps, ~1.04 ETH per wstETH), or FUND=1"
      # Sepolia runs Amsterdam's state-creation pricing (~1,550 gas per byte of deployed code, 31M gas for a 20 KB
      # contract; checked with eth_estimateGas 2026-10-23), which forge's local simulation (evm_version cancun) does
      # not know: its gas limits ran out on a fork. Skip it, so forge asks the node to estimate each transaction
      # (--slow sends them one by one, so each estimate sees the previous ones). The script itself still runs first.
      # Public Sepolia RPCs drop some of the thousands of storage reads a tick or trade script makes (each drop was a
      # FatalExternalError before anything was sent, 2026-10-24): let forge retry a failed fork read.
      EXTRA=(--skip-simulation --fork-retries 12 --fork-retry-backoff 2000)
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

# The graduation / order-minimum rows of the three testnets (Deploy.s.sol GRAD_<chainId>):
# quote:graduationFee:minNotional:seatObligation, small testnet values (USDC min order 0.0001, native 0.001).
# v0.8: graduation needs these treasury fees (trade fees at clearing + spread share at close) in each of four
# consecutive expiries: 4 base units of USDC (0.000004) and 1e12 wei of the native coin, so the small seeds of
# scripts/roll-testnet.sh graduate the native/USDC market and let the vaults invest; scripts/test/grad-seed.test.sh
# checks one seed clears them. The whole table is part of the core's init code (every chain carries every row, so they
# share one core address): changing any value here and redeploying gives a NEW core address on every chain. Adding
# GRAD_11155111 (2026-10-23) did exactly that: the live Monad / HyperEVM core 0x7E02…b1f7 was deployed without it, so
# Sepolia gets another address until both are redeployed on TESTNET_SALT_NEXT (founder's call; see TESTNET_SALT).
# A redeploy regenerates the SDK and CRE configs (scripts/deploy-testnet.sh does).
# Sepolia's native row is not cheap like WMON / WHYPE: 0.1 WETH (~240 USD) is both the per-expiry graduation volume
# of the WETH-quoted wstETH/WETH market and the seat obligation of a seat on it, all from faucet ETH, so that market
# (and the pegged vault) will in practice not graduate. It is in the init code of the 0xc0f3 core already deployed on
# Sepolia (2026-10-23); pick a smaller value (e.g. 0.01 WETH) before the next joint redeploy (IMPLEMENTATION_NOTES §7).
testnet_grad() {
  export GRAD_10143="$M_WMON:1000000000000:1000000000000000:100000000000000000,$M_USDC:4:100:100000"
  export GRAD_998="$H_WHYPE:1000000000000:1000000000000000:100000000000000000,$H_USDC:4:100:100000"
  export GRAD_11155111="$S_WETH:1000000000000:1000000000000000:100000000000000000,$S_USDC:4:100:100000"
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
keys = ["confluere", "router", "wrapperFactory", "vaultFactory", "keeperReceiver", "seatRegistry", "positionMarket"]
out = [d[k] for k in keys if k in d] + [v for m in ("vaults", "seatLPTokens") for v in (d.get(m) or {}).values()]
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
# .pools, .vaults, .positionMarket and .seatLPTokens that later steps recorded. When the staged file names the same core as deployments/<chain>.json,
# those records still describe live contracts of that core: copy them back into the stage (they are verified with it).
# A stage that names another core starts empty, as it should.
keep_records() {
  [ -f "$J" ] && [ -f "$1" ] || return 0
  python3 - "$J" "$1" <<'PY'
import json, sys
old, new = (json.load(open(f)) for f in sys.argv[1:3])
if str(old.get("confluere", "")).lower() == str(new.get("confluere", "")).lower() != "":
    kept = [k for k in ("pools", "vaults", "positionMarket", "seatLPTokens") if k in old and k not in new]
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

# preflight: the deployer's balances must cover one seed of every launch pool and of the extra pair, if any, at every
# expiry the pools step opens (EXPIRY plus LATER_EXPIRIES), summed per token, before any pool is created, so a short
# wallet stops here and not halfway. Book layout (SEED_APR_BPS > 0, Seed.s.sol _seedBook and trade): per pool 2 units
# sold and 2 bought, plus one of each per trade round (TRADE_ROUNDS), every buy valued at K (its limit is below K).
# Crossing layout (SEED_APR_BPS=0, Seed.s.sol _seedPool): per pool 1+2+3 units sold, and the same units bought at
# 97/98/99% of K. A pair whose two strikes are equal is one strike (CreatePools). The loop pair uses
# LST_SEED_UNIT_BPS, the extra pair EXTRA_SEED_UNIT_BPS.
# Each buy escrows exactly what the core's placeOrder pulls (OrderLogic, BUY, v0.8 fees): g = quoteUp(units * limit),
# g + floor(g * 150 / 1e6) (the buyer's 0.015% trade fee) + 2 wei per batch of its ttl (SEED_TTL below).
# FUND=1 wraps the missing wrapped-native amount from the native balance (deposit()) and, where the LST mints for
# native coin sent to it (LST_FUND=receive: wstETH on Sepolia), stakes the missing LST the same way; USDC and shMON must
# be obtained by hand (Circle faucet; FastLane deposit). GAS_RESERVE (wei, default 0.5 native; testnet_params may set a
# chain's own) stays unwrapped for gas.
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
  local xbps=${EXTRA_SEED_UNIT_BPS:-$bps} xa=${EXTRA_ASSET:-$ZERO} lbps=${LST_SEED_UNIT_BPS:-${SEED_UNIT_BPS:-100}}
  local nexp=1 later=${LATER_EXPIRIES:-}
  [ -z "$later" ] || nexp=$((1 + $(echo "$later" | tr ',' '\n' | grep -c .)))
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
  [ "$LST" = "$ZERO" ] || pairs+=("$LST=$NATIVE=${LST_STRIKE_LOW:-0}=${LST_STRIKE_HIGH:-0}=$lbps")
  pairs+=("$NATIVE=$USDC=$USD_STRIKE_LOW=$USD_STRIKE_HIGH=$bps")
  [ "$xa" = "$ZERO" ] || pairs+=("$xa=$EXTRA_QUOTE=$EXTRA_STRIKE_LOW=$EXTRA_STRIKE_HIGH=$xbps")
  local plan
  plan=$(python3 - "$(rcast balance "$me" --rpc-url "$R")" "${GAS_RESERVE:-500000000000000000}" "${SEED_TTL:-48}" \
    "${toks[*]}" "${pairs[*]}" "$nexp" "${SEED_APR_BPS:-0}" "${TRADE_ROUNDS:-0}" <<'PY'
import sys
gas, reserve, ttl, toks, pairs, nexp, apr, rounds = sys.argv[1:]
def esc(units, limit, d, ttl):
    g = -(-units * limit // 10 ** d)
    return g + g * 150 // 1_000_000 + 2 * ttl  # SDK buyEscrow
ttl, nexp, book, rounds = int(ttl), int(nexp), int(apr) > 0, int(rounds)
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
    strikes = sorted({int(k1), int(k2)})  # equal strikes: one strike (CreatePools)
    for k in strikes:
        if book:
            # Seed._seedBook + trade(), per kind (2) and expiry: 2 + rounds sells and buys of u, each buy escrowing
            # buyEscrow(u, limit, ttl) valued at K > limit (OrderLogic placeOrder, BUY)
            n = 2 * nexp * (2 + rounds)
            tok[asset.lower()][3] += n * u
            tok[quote.lower()][3] += n * esc(u, k, d, ttl)
            continue
        # Seed._seedPool per kind (2): sells of u*(j+1) (6 units), buys of u*(j+1) at K*(97+j)/100 for j = 0..2
        tok[asset.lower()][3] += 2 * nexp * 6 * u
        for j in range(3):
            units, limit = u * (j + 1), k * (97 + j) // 100
            tok[quote.lower()][3] += 2 * nexp * esc(units, limit, d, ttl)
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
  local short_nat avail reserve eth
  short_nat=$(echo "$plan" | awk '$1=="native"{print $4}')
  avail=$(echo "$plan" | awk '$1=="gas"{print $3}') # native coin left after what FUND=1 already spent
  reserve=$(echo "$plan" | awk '$1=="gas"{print $2}')
  # spend AMOUNT: true when the native coin left after AMOUNT still covers GAS_RESERVE (wei, beyond 64-bit shell math)
  spend() { python3 -c "import sys; a, x, r = map(int, sys.argv[1:]); sys.exit(0 if a - x >= r else 1)" "$avail" "$1" "$reserve"; }
  local fail=0 lbl need have short addr
  while read -r lbl need have short addr; do
    [ "$short" != 0 ] || continue
    case $lbl in
      native)
        if [ "${FUND:-0}" = 1 ] && spend "$short_nat"; then
          echo "  FUND=1: wrapping $short_nat wei into $NATIVE"
          cast send "$NATIVE" "deposit()" --value "$short_nat" --rpc-url "$R" "${SIGNER[@]}" >/dev/null </dev/null
          avail=$(python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$avail" "$short_nat")
        else
          echo "  short of wrapped native $NATIVE by $short_nat: cast send $NATIVE 'deposit()' --value $short_nat ..."
          echo "  (or re-run with FUND=1; it keeps GAS_RESERVE=$reserve wei of native for gas)"
          fail=1
        fi ;;
      usdc) echo "  short of USDC $USDC by $short (6 decimals): https://faucet.circle.com"; fail=1 ;;
      lst)
        # the native coin that mints `short` LST: the token's own rate, plus 1 gwei for the share rounding of staking
        eth=""
        if [ "${FUND:-0}" = 1 ] && [ "${LST_FUND:-}" = receive ]; then
          eth=$(rcast call "$LST" "getStETHByWstETH(uint256)(uint256)" "$short" --rpc-url "$R" | awk '{print $1}')
          eth=$(python3 -c "import sys; print(int(sys.argv[1]) + 10**9)" "$eth")
        fi
        if [ -n "$eth" ] && spend "$eth"; then
          echo "  FUND=1: staking $eth wei into $LST for $short LST"
          cast send "$LST" --value "$eth" --rpc-url "$R" "${SIGNER[@]}" >/dev/null </dev/null
          avail=$(python3 -c "import sys; print(int(sys.argv[1]) - int(sys.argv[2]))" "$avail" "$eth")
        else
          echo "  short of LST $LST by $short: ${LST_HINT:-obtain it by hand}"
          [ -z "$eth" ] || echo "  (FUND=1 would stake $eth wei but keeps GAS_RESERVE=$reserve wei of native for gas)"
          fail=1
        fi ;;
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

# launch_expiries: on a daily grid (deployments gridPeriod = 1 day), EXPIRY = the first expiry at least LAUNCH_LEAD
# seconds away (default 12 h: the "1-day" pool) and LATER_EXPIRIES = the expiries MATURITY_DAYS - 1 periods after it
# (7 and 14 days by default). Other grids: CreatePools takes the nearest expiry as before.
launch_expiries() {
  local period anchor now
  period=$(jget "$J" gridPeriod); anchor=$(jget "$J" gridAnchor)
  [ "$period" = 86400 ] || return 0
  now=$(rcast block latest -f timestamp --rpc-url "$R")
  read -r EXPIRY LATER_EXPIRIES <<<"$(python3 -c '
import sys
anchor, period, now, lead = (int(x) for x in sys.argv[1:5])
days = [int(x) for x in sys.argv[5].split()]
e = anchor + ((now - anchor) // period + 1) * period
while e - now < lead:
    e += period
print(e, ",".join(str(e + (d - days[0]) * period) for d in days[1:]))
' "$anchor" "$period" "$now" "${LAUNCH_LEAD:-43200}" "$MATURITY_DAYS")"
  export EXPIRY LATER_EXPIRIES
  echo "  expiries: $EXPIRY ${LATER_EXPIRIES:+(and $LATER_EXPIRIES)}"
}

# wait_batch: sleeps until just past the next batch boundary of the deployment's grid (15 s margin).
wait_batch() {
  local iv anchor now
  iv=$(jget "$J" batchInterval); anchor=$(jget "$J" gridAnchor)
  now=$(rcast block latest -f timestamp --rpc-url "$R")
  sleep "$((iv - (now - anchor) % iv + 15))"
}

# trade_rounds: TRADE_ROUNDS rounds of small crossing trades in every pool of .pools.poolIds (Seed.s.sol trade(), each
# round one batch later), each preceded by a KeeperReceiver tick that settles what is due (racing the keeper is
# harmless: the receiver skips pools that are not due), and a last tick so the last round clears.
trade_rounds() {
  local r
  [ "${TRADE_ROUNDS:-0}" -gt 0 ] || return 0
  for ((r = ${TRADE_FROM:-0}; r < TRADE_ROUNDS; r++)); do # TRADE_FROM: continue after an interrupted round
    wait_batch
    run "tick: settle due pools" script/Seed.s.sol 0 --sig "tick()"
    TRADE_ROUND=$r run "trade round $r" script/Seed.s.sol 0 --sig "trade()"
  done
  wait_batch
  run "tick: settle due pools" script/Seed.s.sol 0 --sig "tick()"
}

# Regenerate what reads deployments/*.json: SDK addresses and the CRE workflow config (receiver, vaults, live pools).
# One CRE config per chain (services/keeper-cre/scripts/sync-config.mjs CRE_CHAINS): Monad testnet writes
# config.staging.json, Sepolia config.sepolia.json (created on its first sync). Sepolia's scan from deployBlock does not
# use $R: publicnode prunes logs older than ~10,000 blocks, so sync-config takes its own archive RPC (1,000-block
# chunks) unless SEPOLIA_LOGS_RPC names another. HyperEVM testnet has no CRE workflow.
sync_offchain() {
  (cd "$ROOT/packages/sdk" && node scripts/sync-deployments.mjs && pnpm -s build)
  if [ "$CHAIN" = monad ]; then
    (cd "$ROOT" && DEPLOYMENT=monad-testnet RPC_URL="$R" pnpm --filter @confluere/keeper-cre -s sync-config)
  elif [ "$CHAIN" = sepolia ]; then
    (cd "$ROOT" && env DEPLOYMENT=sepolia CRE_CONFIG=config.sepolia.json ${SEPOLIA_LOGS_RPC:+RPC_URL="$SEPOLIA_LOGS_RPC"} \
      pnpm --filter @confluere/keeper-cre -s sync-config)
  else
    echo "CRE config not touched: no CRE workflow for $NAME"
  fi
}
