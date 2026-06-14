#!/usr/bin/env bash
# Fast functional run (~10-15 min): skips @slow tests.
# Uses restart-tester.sh (verified fresh :3004 bot). Steve/Gatherer left alone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Verified fresh restart (reaps :3004 orphans + asserts the new bot is live on
# current code) so the suite never runs against stale code.
"$ROOT/scripts/restart-tester.sh"
.venv/bin/pytest -m "functional and not slow and not integration and not colony" --durations=15 -q --tb=short "$@"
