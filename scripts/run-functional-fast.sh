#!/usr/bin/env bash
# Fast functional run (~10-15 min): skips @slow tests.
# Restarts Tester only (Steve/Gatherer left alone — see stop-bots.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/stop-bots.sh" Tester --quiet || true
"$ROOT/scripts/run-tester-bot.sh"
.venv/bin/pytest -m "functional and not slow and not integration" --durations=15 -q --tb=short "$@"
