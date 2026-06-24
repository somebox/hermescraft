#!/usr/bin/env bash
# Start Landfolk bot bodies (Gatherer, Flint, Mason, Barley) on API ports from
# data/agent-models.json. Port 3004 is reserved for Tester — see data/bots/tester.yaml.
# Steve companion uses the same default API port (3001) — run either Steve OR Gatherer on 3001, not both.
set -euo pipefail

MC_HOST="${MC_HOST:-localhost}"
MC_PORT="${1:?Usage: run-landfolk-bots.sh MC_PORT}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$SCRIPT_DIR/bot"
MODELS="${AGENT_MODELS_JSON:-$SCRIPT_DIR/data/agent-models.json}"
RESOLVE="$SCRIPT_DIR/scripts/resolve-agent-model.py"

cd "$BOT_DIR"

run_bot() {
  local name="$1"
  local api_port
  api_port="$(python3 "$RESOLVE" api-port "$name" "$MODELS")"
  local viewer_port=$((api_port + 1000))
  echo "[bot] starting $name on API $api_port viewer $viewer_port -> $MC_HOST:$MC_PORT"
  MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$name" API_PORT="$api_port" VIEWER_PORT="$viewer_port" \
    node server.js > "/tmp/bot-${name,,}.log" 2>&1 &
}

run_bot Gatherer
sleep 1
run_bot Flint
sleep 1
run_bot Mason
sleep 1
run_bot Barley

echo
printf '[bot] started landfolk bodies on MC port %s\n' "$MC_PORT"
echo '[bot] logs: /tmp/bot-gatherer.log ... /tmp/bot-barley.log'
wait
