#!/usr/bin/env bash
set -euo pipefail

MC_PORT="${1:?Usage: run-steve-bot.sh MC_PORT}"
MC_HOST="${MC_HOST:-localhost}"
API_PORT="${API_PORT:-3001}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$SCRIPT_DIR/bot"

# Source .env for PAPERMCP_TOKEN etc. Without this paperMcpConfig() returns
# null and all PaperMCP server-side fallbacks (boat placement, 3x3 craft
# delta=0, bonemeal, etc.) silently degrade to native-only. Discovered
# live in circuit-v5: place_boat returned PLACE_FAILED on every shallow-
# water cast because the fallback path was never enabled.
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

cd "$BOT_DIR"

echo "[Steve bot] starting Steve on API ${API_PORT} -> ${MC_HOST}:${MC_PORT}"
MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="Steve" API_PORT="$API_PORT" node server.js > /tmp/bot-steve.log 2>&1
