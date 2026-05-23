#!/usr/bin/env bash
# Reactive L3 combat scenarios — pytest port (canonical harness + Tester).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
"$ROOT/scripts/stop-bots.sh" Tester --quiet || true
"$ROOT/scripts/run-tester-bot.sh"
exec "$ROOT/.venv/bin/pytest" -m "functional and slow" tests/functional/combat --durations=15 -q --tb=short "$@"
