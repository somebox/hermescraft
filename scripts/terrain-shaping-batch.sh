#!/usr/bin/env bash
# Batch driver for terrain-shaping context tests (run → summary → fix-backlog).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/context-tests/terrain-shaping-batch.mjs" "$@"
