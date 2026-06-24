#!/usr/bin/env bash
# Fast functional run (~10-15 min): skips @slow tests.
# Uses restart-tester.sh (verified fresh :3004 bot). Steve/Gatherer left alone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Construct canary tests require HERMES_CONSTRUCT_CONTEXT on the Tester process
# (see docs/architecture/construct-canary.md).
HERMES_CONSTRUCT_CONTEXT=1 "$ROOT/scripts/restart-tester.sh"
.venv/bin/pytest -m "functional and not slow and not integration and not colony" --durations=15 -q --tb=short "$@"
