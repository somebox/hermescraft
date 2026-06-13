#!/usr/bin/env bash
# Full functional run (~15-25 min): all functional tests.
# Restarts Tester only (Steve/Gatherer left alone — see stop-bots.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Verified fresh restart (reaps :3004 orphans + asserts the new bot is live on
# current code) so the suite never runs against stale code.
"$ROOT/scripts/restart-tester.sh"
.venv/bin/pytest -m "functional and not integration and not colony" --durations=30 -q --tb=short "$@"
