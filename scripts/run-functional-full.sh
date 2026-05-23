#!/usr/bin/env bash
# Full functional run (~15-25 min): all functional tests.
# Restarts Tester only (Steve/Gatherer left alone — see stop-bots.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/stop-bots.sh" Tester --quiet || true
"$ROOT/scripts/run-tester-bot.sh"
.venv/bin/pytest -m "functional and not integration" --durations=30 -q --tb=short "$@"
