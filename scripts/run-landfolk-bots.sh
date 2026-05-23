#!/usr/bin/env bash
# Start Landfolk bot bodies (Gatherer, Flint, Mason, Barley) on ports 3001–3004.
# Steve companion uses the same default API port (3001) — run either Steve OR Gatherer on 3001, not both.
set -euo pipefail

MC_HOST="${MC_HOST:-localhost}"
MC_PORT="${1:?Usage: run-landfolk-bots.sh MC_PORT}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$SCRIPT_DIR/bot"

cd "$BOT_DIR"

run_bot() {
  local name="$1"
  local api_port="$2"
  local viewer_port=$((api_port + 1000))
  echo "[bot] starting $name on API $api_port viewer $viewer_port -> $MC_HOST:$MC_PORT"
  MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$name" API_PORT="$api_port" VIEWER_PORT="$viewer_port" \
    node server.js > "/tmp/bot-${name,,}.log" 2>&1 &
}

run_bot Gatherer 3001
sleep 1
run_bot Flint 3002
sleep 1
run_bot Mason 3003
sleep 1
run_bot Barley 3004

echo
printf '[bot] started landfolk bodies on MC port %s\n' "$MC_PORT"
echo '[bot] logs: /tmp/bot-gatherer.log ... /tmp/bot-barley.log'
wait
