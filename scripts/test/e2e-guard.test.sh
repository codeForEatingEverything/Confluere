#!/usr/bin/env bash
# Offline tests for the guards of scripts/e2e-anvil.sh: it never runs on a chain it did not start (port 8545 busy),
# gives up on an anvil that dies or never answers instead of waiting forever, stops an anvil only when its own pid file
# names it, and stops at a failing forge script instead of carrying on. cast, anvil, forge, pnpm and sleep are fakes on
# PATH; nothing listens on 8545. Runs on macOS and Linux: bash scripts/test/e2e-guard.test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d "${TMPDIR:-/tmp}/e2e-guard.XXXXXX")
BG=()
cleanup() {
  local p
  for p in ${BG[@]+"${BG[@]}"}; do kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/bin" "$T/root/contracts" "$T/tmp"
cp -R "$ROOT/scripts" "$T/root/scripts"
CALLS="$T/calls.log"
export CALLS UP="$T/anvil.up"

# cast chain-id answers while FAKE_BUSY=1 (someone else's chain) or once the fake anvil is up
cat > "$T/bin/cast" <<'EOF'
#!/usr/bin/env bash
echo "cast $*" >> "$CALLS"
case "$1" in
  chain-id) { [ "${FAKE_BUSY:-0}" = 1 ] || [ -f "$UP" ]; } && echo 31337 && exit 0; exit 1 ;;
esac
EOF
# FAKE_ANVIL: up (answers), dead (exits at once, as when the port is taken), hang (runs, never answers)
cat > "$T/bin/anvil" <<'EOF'
#!/usr/bin/env bash
echo "anvil $*" >> "$CALLS"
case "${FAKE_ANVIL:-up}" in
  dead) exit 1 ;;
  up) touch "$UP" ;;
esac
exec /bin/sleep 300
EOF
cat > "$T/bin/forge" <<'EOF'
#!/usr/bin/env bash
echo "forge $*" >> "$CALLS"
if [ "${FAKE_FORGE_FAIL:-0}" = 1 ]; then echo "Error: script failed: revert"; exit 1; fi
echo "SUCCESS"
EOF
cat > "$T/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "pnpm $*" >> "$CALLS"
EOF
cat > "$T/bin/sleep" <<'EOF'
#!/usr/bin/env bash
echo "sleep $*" >> "$CALLS"
EOF
# never let a test stop a real process by name
cat > "$T/bin/pkill" <<'EOF'
#!/usr/bin/env bash
echo "pkill $*" >> "$CALLS"
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH" TMPDIR="$T/tmp"

fail() { echo "FAIL: $*"; [ -f "$T/out" ] && sed 's/^/  | /' "$T/out"; exit 1; }
# e2e: run the script with a 30 s watchdog (fake sleep makes every wait loop instant); status in $RC
e2e() {
  rm -f "$UP"; : > "$CALLS"
  "$T/root/scripts/e2e-anvil.sh" > "$T/out" 2>&1 &
  local pid=$! i
  for i in $(seq 1 300); do kill -0 "$pid" 2>/dev/null || break; /bin/sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fail "e2e-anvil.sh still waiting after 30 s"; fi
  RC=0; wait "$pid" || RC=$?
}
alive() { kill -0 "$1" 2>/dev/null; }

# port 8545 already answers before anything was started: refuse, start no anvil
FAKE_BUSY=1 e2e
[ "$RC" != 0 ] || fail "ran on a busy port"
grep -q "port 8545 is busy" "$T/out" || fail "no busy-port message"
grep -q "^anvil" "$CALLS" && fail "started anvil although the port was busy"
grep -q "^forge" "$CALLS" && fail "ran forge against someone else's chain"

# anvil exits at once: stop with a message, no endless wait
FAKE_ANVIL=dead e2e
[ "$RC" != 0 ] || fail "passed with a dead anvil"
grep -q "anvil failed to start" "$T/out" || fail "no message for a dead anvil"

# anvil runs but never answers: give up after the bounded wait
FAKE_ANVIL=hang e2e
[ "$RC" != 0 ] || fail "passed with a silent anvil"
grep -q "did not answer on 8545" "$T/out" || fail "no timeout message"
[ "$(grep -c '^sleep 0.5' "$CALLS")" -le 80 ] || fail "wait loop not bounded"

# a failing forge script stops the run at that step, with its error, before anything else runs
FAKE_FORGE_FAIL=1 e2e
[ "$RC" != 0 ] || fail "a failing Deploy forge script did not fail the run"
grep -q "FAIL: forge script script/Deploy.s.sol" "$T/out" || fail "forge failure not named"
grep -q "Error: script failed" "$T/out" || fail "forge log tail not shown"
grep -q "^pnpm" "$CALLS" && fail "the run went on after a failed forge script"
[ -z "$(ls -A "$T/tmp" | grep -v '^confluere-e2e-anvil.pid$' || true)" ] || fail "temporary files left: $(ls -A "$T/tmp")"
[ ! -f "$T/tmp/confluere-e2e-anvil.pid" ] || fail "pid file left after the run"

# pid file: an anvil an earlier (interrupted) run started is stopped; another process named like anvil, not in the
# pid file, and an unrelated pid in the pid file are left alone
bash -c 'exec -a "anvil --port 8545 --silent" /bin/sleep 300' & OWN=$!; BG+=("$OWN")
bash -c 'exec -a "anvil --port 8545" /bin/sleep 300' & FOREIGN=$!; BG+=("$FOREIGN")
/bin/sleep 0.3
echo "$OWN" > "$T/tmp/confluere-e2e-anvil.pid"
FAKE_FORGE_FAIL=1 e2e
alive "$OWN" && fail "the earlier run's anvil (pid file) was not stopped"
alive "$FOREIGN" || fail "stopped an anvil this script did not start"
/bin/sleep 300 & OTHER=$!; BG+=("$OTHER")
echo "$OTHER" > "$T/tmp/confluere-e2e-anvil.pid"
FAKE_FORGE_FAIL=1 e2e
alive "$OTHER" || fail "stopped a non-anvil process named by a stale pid file"

echo "e2e-guard tests OK"
