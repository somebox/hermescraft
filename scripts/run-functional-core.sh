#!/usr/bin/env bash
# Core functional smoke (~5–10 min): @functional_core only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HERMES_CONSTRUCT_CONTEXT=1 "$ROOT/scripts/restart-tester.sh"
.venv/bin/pytest -m "functional_core" --durations=15 -q --tb=short "$@"
