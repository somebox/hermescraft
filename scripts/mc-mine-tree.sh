#!/usr/bin/env bash
# Find nearby logs (tree trunks), then mine a few blocks of the first variety found.
#
# Uses the same MC host as gatherer scripts for the CLI only affects HTTP to the bot API.
#
# Prerequisites: bot listening (e.g. scripts/start-gatherer-bot.sh).
# discover uses a world scan so nearby trunks show up even when leaves hide them from LOS raycasts.
# collect still needs the log block in view when FAIR_PLAY=true — face a tree or mc goto_near toward a location.
# Env:
#   MC_API_URL   default http://127.0.0.1:3001
#   MC_HTTP_LONG_ACTION_MS — HTTP wait for mc collect etc. (default 120000 ms via bot/cli/http.mjs).
#     Raise if CLI shows AbortError while the bot still finishes mining.
#
# Usage:
#   ./scripts/mc-mine-tree.sh [COUNT]
#   LOG_RADIUS=96 ./scripts/mc-mine-tree.sh 8
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COUNT="${1:-5}"
COUNT="$(( COUNT > 20 ? 20 : COUNT ))" # server caps batch per collect call at 20
LOG_RADIUS="${LOG_RADIUS:-64}"
export MC_API_URL="${MC_API_URL:-http://127.0.0.1:3001}"
export PATH="$ROOT/bin:${PATH}"

if ! command -v mc >/dev/null 2>&1; then
  echo "mc not found; expected $ROOT/bin/mc"; exit 1
fi

echo "  Discover logs within ~${LOG_RADIUS} blocks (via bot API $MC_API_URL)..."
TMP="$(mktemp)"
cleanup() { rm -f "${TMP:-}"; }
trap cleanup EXIT
mc discover logs "$LOG_RADIUS" --json >"$TMP" || exit 1

set +e
PICK="$(
  python3 -c '
import json, sys, pathlib
raw = json.load(pathlib.Path(sys.argv[1]).open())
data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
disc = (data or {}).get("discover") or {}
blocks = disc.get("blocks") or []
if not blocks:
    sys.exit(2)
for b in blocks:
    name = b.get("name")
    locs = b.get("locations") or []
    if name and len(locs) > 0:
        print(name)
        sys.exit(0)
n = blocks[0].get("name") or ""
if n:
    print(n)
else:
    sys.exit(2)
' "$TMP"
)"
py=$?
set -e

if [[ "$py" -ne 0 ]]; then BLOCK=""; else BLOCK="$PICK"; fi

if [[ -z "$BLOCK" ]]; then
  echo ""
  echo "  No log blocks reported in radius. Summary:"
  python3 -c "import json, pathlib; d=json.load(pathlib.Path('$TMP').open()); print(json.dumps(d, indent=2)[:4000])" 2>/dev/null || cat "$TMP"
  echo ""
  echo "  Try: wider radius LOG_RADIUS=96, move the bot closer to trees, or mc scene / mc discover wood 96"
  exit 1
fi

echo "  Collecting ${COUNT} × ${BLOCK} (fair-play: bot must see the block)..."
mc collect "$BLOCK" "$COUNT" --json
