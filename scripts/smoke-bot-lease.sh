#!/usr/bin/env bash
# smoke-bot-lease.sh — dry checks for bot lease MVP (+ optional live MC).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/bot"

echo "[smoke-bot-lease] unit tests (lease-registry)"
node --test test/cli/lease-registry.test.js

echo "[smoke-bot-lease] genesis-v2 mint contract (static)"
grep -q "HERMES_BOT_LEASE" "$ROOT/scripts/genesis-v2-mint-profiles.sh"
grep -q "delkv(lines, 'MC_API_URL')" "$ROOT/scripts/genesis-v2-mint-profiles.sh"

echo "[smoke-bot-lease] mc bot help surface"
node cli/index.mjs bot status --json >/dev/null 2>&1 || {
  # status may fail without lease in lease-mode — checkout first in adhoc mode
  export HERMES_BOT_LEASE=1
  export HERMES_BOT_LEASE_DB="${HERMES_BOT_LEASE_DB:-/tmp/smoke-bot-lease-$$.db}"
  rm -f "$HERMES_BOT_LEASE_DB"
  node cli/index.mjs bot checkout --bot mox --json >/dev/null
  node cli/index.mjs bot status --json >/dev/null
}

if [[ "${SMOKE_BOT_LEASE_LIVE:-}" == "1" ]]; then
  echo "[smoke-bot-lease] live ports (SMOKE_BOT_LEASE_LIVE=1)"
  export HERMES_BOT_LEASE=1
  export HERMES_BOT_LEASE_DB="${HERMES_BOT_LEASE_DB:-/tmp/smoke-bot-lease-live-$$.db}"
  rm -f "$HERMES_BOT_LEASE_DB"
  node cli/index.mjs bot checkout --bot mox --json
  HERMES_BOT_LEASE=1 node cli/index.mjs status --json
  node cli/index.mjs bot release
fi

echo "[smoke-bot-lease] OK"
