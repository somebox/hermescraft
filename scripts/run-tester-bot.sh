#!/usr/bin/env bash
# Tester is the canonical test-only bot. Lives on port 3004, identity
# 'Tester', dimension `landfolk-test`. The pytest harness in tests/
# expects it there (see tests/conftest.py + config/hermescraft.yaml).
#
# Steve (production circuit bot) is on 3001. They must not collide.
#
# Usage: ./scripts/run-tester-bot.sh
#
# Env overrides:
#   MC_HOST       (default 192.168.1.202 — ubuntu-host)
#   MC_PORT       (default 25565)
#   API_PORT      (default 3004 — conftest expects this)
#   VIEWER_PORT   (default 4004 — avoid 4001 conflict with Steve)
#   LOG_DIR       (default /tmp/hermescraft)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
API_PORT="${API_PORT:-3004}"
VIEWER_PORT="${VIEWER_PORT:-4004}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"

mkdir -p "$LOG_DIR"

# Source .env so PAPERMCP_TOKEN etc. reach the bot process. Same reasoning
# as run-steve-bot.sh — without this, server-side fallbacks (boat
# placement, 3x3 craft, bonemeal) silently degrade.
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

echo "── stopping any existing Tester ──"
"$SCRIPT_DIR/scripts/stop-bots.sh" Tester --quiet || true
sleep 1

echo "── starting Tester bot on :$API_PORT (viewer :$VIEWER_PORT) → $MC_HOST:$MC_PORT ──"
cd "$SCRIPT_DIR/bot"
MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="Tester" \
  BOT_ACCEPT_SERVER_CHAT=true \
  API_PORT="$API_PORT" VIEWER_PORT="$VIEWER_PORT" \
  nohup node server.js > "$LOG_DIR/bot-tester.log" 2>&1 &
disown
BOT_PID=$!
echo "  bot pid: $BOT_PID"

echo "── waiting for bot handshake with $MC_HOST:$MC_PORT ──"
for i in $(seq 1 25); do
  conn=$(curl -sf "http://localhost:$API_PORT/health" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected'))" 2>/dev/null || echo "")
  if [ "$conn" = "True" ]; then
    echo "  bot ready ($i s)"
    break
  fi
  sleep 1
done

echo ""
echo "── Tester is up ──"
echo "  bot     pid $BOT_PID    http://localhost:$API_PORT  (viewer: http://localhost:$VIEWER_PORT/)"
echo "  log     tail -F $LOG_DIR/bot-tester.log"
echo ""
echo "  Next step before running tests: mvtp Tester to landfolk-test"
echo "  (the test runner script handles this; run pytest directly only"
echo "   if Tester is already in landfolk-test)."
