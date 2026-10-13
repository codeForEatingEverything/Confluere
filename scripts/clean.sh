#!/usr/bin/env bash
# Removes caches and build artifacts that are safe to regenerate. Never touches sources, node_modules
# (pnpm hard-links them to its store, so they are not duplicated) or contracts/out (needed for codegen).
# Manual only: pnpm clean
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.foundry/bin"
for d in "$HOME"/.local/share/fnm/node-versions/*/installation/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== confluere clean $(date '+%F %T')"
before=$(df -k "$HOME" | awk 'NR==2{print $4}')

# repo build artifacts
rm -rf "$ROOT/apps/web/.next" "$ROOT"/.turbo "$ROOT"/*/*/.turbo \
  "$ROOT/contracts/crytic-export" "$ROOT/contracts/medusa-corpus" \
  "$ROOT/contracts/out-halmos" "$ROOT/contracts/cache-halmos" \
  "$ROOT/services/keeper-cre/dist" "$ROOT"/contracts/broadcast/*/31337

# package-manager caches
pnpm store prune >/dev/null 2>&1 && echo "pnpm store pruned"
npm cache clean --force >/dev/null 2>&1 && echo "npm cache cleared"
rm -rf "$HOME/.npm/_npx" && echo "npx cache cleared"

after=$(df -k "$HOME" | awk 'NR==2{print $4}')
echo "freed about $(( (after - before) / 1024 )) MB"
