#!/usr/bin/env bash
# HermesCraft — start the Gatherer Mineflayer HTTP bot only (no Hermes).
#
# Uses the SAME defaults as ./start-gatherer.sh:
#   MC_HOST=192.168.1.202  MC_PORT=25565  MC_USERNAME=Gatherer  API_PORT=3001
#
# For the full launcher (Hermes + monitor), use:
#   ./start-gatherer.sh MODEL
#
# Testing the Node mc CLI against this API:
#   export MC_API_URL=http://127.0.0.1:${API_PORT}
#   mc health --json
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$ROOT/bot"
BIN_DIR="$ROOT/bin"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
MC_USERNAME="${MC_USERNAME:-Gatherer}"
API_PORT="${API_PORT:-3001}"
FAIR_PLAY="${FAIR_PLAY:-true}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
KILL_PORT=false
DAEMON=false

usage() {
  sed -n '1,20p' "$0" | tail -n +2
  echo ""
  echo "Usage: $0 [options]"
  echo ""
  echo "Options:"
  echo "  --mc-host H     Minecraft server (default $MC_HOST)"
  echo "  --mc-port P     Minecraft port (default $MC_PORT)"
  echo "  --name NAME     Bot username (default $MC_USERNAME)"
  echo "  --port N        Bot HTTP API port (default $API_PORT)"
  echo "  --kill-port     Free API_PORT if something is already listening"
  echo "  --daemon        Run in background; log to \$LOG_DIR/bot-<user>.log"
  echo "  -h, --help      This help"
  echo ""
  echo "Environment: MC_HOST MC_PORT MC_USERNAME API_PORT FAIR_PLAY LOG_DIR"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mc-host) MC_HOST="$2"; shift 2 ;;
    --mc-port) MC_PORT="$2"; shift 2 ;;
    --name) MC_USERNAME="$2"; shift 2 ;;
    --port) API_PORT="$2"; shift 2 ;;
    --kill-port) KILL_PORT=true; shift ;;
    --daemon) DAEMON=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 1 ;;
  esac
done

MC_USERNAME_LC="$(printf '%s' "$MC_USERNAME" | tr '[:upper:]' '[:lower:]')"
API_URL="http://127.0.0.1:${API_PORT}"
export PATH="$BIN_DIR:$PATH"

[ -d "$BOT_DIR/node_modules" ] || { echo "Installing bot deps..."; (cd "$BOT_DIR" && npm install --no-audit --no-fund); }

if command -v lsof &>/dev/null && lsof -ti ":$API_PORT" &>/dev/null; then
  if [[ "$KILL_PORT" == true ]]; then
    echo "  Freeing port $API_PORT ..."
    lsof -ti ":$API_PORT" | xargs kill 2>/dev/null || true
    sleep 1
  else
    echo "  Port $API_PORT is already in use. Use --kill-port to stop the old listener, or set API_PORT."
    exit 1
  fi
fi

mkdir -p "$LOG_DIR"

echo ""
echo "  Bot: $MC_USERNAME → Minecraft $MC_HOST:$MC_PORT"
echo "  HTTP API: $API_URL  (set MC_API_URL for ./bin/mc)"
echo ""

if [[ "$DAEMON" == true ]]; then
  LOG_FILE="$LOG_DIR/bot-${MC_USERNAME_LC}.log"
  (
    cd "$BOT_DIR"
    FAIR_PLAY="$FAIR_PLAY" \
      MC_HOST="$MC_HOST" \
      MC_PORT="$MC_PORT" \
      MC_USERNAME="$MC_USERNAME" \
      API_PORT="$API_PORT" \
      node server.js
  ) >"$LOG_FILE" 2>&1 &
  BOT_PID=$!
  echo "  Daemon PID $BOT_PID  log: $LOG_FILE"
  for _ in $(seq 1 25); do
    curl -sf "$API_URL/health" &>/dev/null && break
    kill -0 "$BOT_PID" 2>/dev/null || { echo "  Bot exited — see $LOG_FILE"; exit 1; }
    sleep 1
  done
  echo "  ✓ API up — try: MC_API_URL=$API_URL mc health --json"
  echo "  Mine a tree: MC_API_URL=$API_URL $ROOT/scripts/mc-mine-tree.sh"
  echo "  Command center: http://127.0.0.1:${DASHBOARD_PORT:-3000}  (./start-dashboard.sh)"
  exit 0
fi

echo "  (foreground; Ctrl+C to stop)"
echo "  Try: MC_API_URL=$API_URL mc health --json"
echo "  Mine a tree: MC_API_URL=$API_URL $ROOT/scripts/mc-mine-tree.sh"
echo ""
cd "$BOT_DIR"
exec env \
  FAIR_PLAY="$FAIR_PLAY" \
  MC_HOST="$MC_HOST" \
  MC_PORT="$MC_PORT" \
  MC_USERNAME="$MC_USERNAME" \
  API_PORT="$API_PORT" \
  node server.js
