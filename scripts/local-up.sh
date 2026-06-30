#!/usr/bin/env bash
# Bring up the local stack for arena/functional tests:
#   1. Paper + Multiverse server (server/local-start.sh)
#   2. Tester bot on :3004, connected to localhost and moved into landfolk-test
#
# Usage:
#   scripts/local-up.sh              # server + Tester bot
#   scripts/local-up.sh --no-bot     # server only
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WITH_BOT=1
[ "${1:-}" = "--no-bot" ] && WITH_BOT=0

echo "── local stack up ──"
server/local-start.sh

if [ "$WITH_BOT" = 1 ]; then
  echo "── starting Tester bot (:3004 → localhost:25565) ──"
  MC_HOST=localhost MC_PORT=25565 scripts/run-tester-bot.sh

  echo "── moving Tester into landfolk-test ──"
  # Match what the runner scripts do so pytest can be invoked directly.
  server/rcon.sh \
    "mvtp Tester landfolk-test" \
    "execute in landfolk-test run forceload add -32 -32 32 32" \
    "execute in landfolk-test run tp Tester 0 65 0" \
    "gamemode survival Tester" >/dev/null || true
fi

echo
echo "  ✓ local stack ready."
echo "    Tests:   HERMESCRAFT_PROFILE=local pytest -m 'functional and not slow and not colony'"
echo "    Down:    scripts/local-down.sh"
