#!/usr/bin/env bash
# Tear down the local stack: stop bots, then the Paper server.
# Usage: scripts/local-down.sh
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "── local stack down ──"
# Stop known local bots (best-effort; --all also catches fleet bodies).
scripts/stop-bots.sh --all --quiet 2>/dev/null || true
server/local-stop.sh
echo "  ✓ down."
