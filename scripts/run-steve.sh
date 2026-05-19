#!/usr/bin/env bash
# Single-command Steve lifecycle:
#   - kills any existing Steve agent + bot processes
#   - launches the Mineflayer bot on :3001 (+ FPV viewer on :4001) pointed at
#     the ubuntu-host Paper server
#   - launches the Hermes agent with MC_FORCE_REASON=1
#   - prints the two canonical follow commands (watch-steve.py, watch-advise.py)
#
# Idempotent. Re-running is the supported way to restart.
#
# Env overrides:
#   MC_HOST       (default 192.168.1.202 — ubuntu-host)
#   MC_PORT       (default 25565)
#   API_PORT      (default 3001)
#   VIEWER_PORT   (default 4001)
#   AGENT_HOME    (default ~/.hermes-landfolk-steve)
#   LOG_DIR       (default /tmp/hermescraft)
#   NO_AGENT=1    (skip launching the brain — bot only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
API_PORT="${API_PORT:-3001}"
VIEWER_PORT="${VIEWER_PORT:-4001}"
AGENT_HOME="${AGENT_HOME:-$HOME/.hermes-landfolk-steve}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"

mkdir -p "$LOG_DIR"

echo "── stopping any existing Steve ──"
pkill -f 'run-landfolk-agent.sh Steve' 2>/dev/null || true
pkill -f 'hermes chat.*hermes-landfolk-steve' 2>/dev/null || true
pkill -f 'MC_USERNAME=Steve' 2>/dev/null || true
sleep 2
# Belt-and-suspenders: free the ports if anything still holds them
for p in "$API_PORT" "$VIEWER_PORT"; do
  pids=$(lsof -ti tcp:"$p" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  freeing port $p (pids: $pids)"
    kill $pids 2>/dev/null || true
  fi
done
sleep 1

echo "── starting bot on :$API_PORT (viewer :$VIEWER_PORT) → $MC_HOST:$MC_PORT ──"
MC_HOST="$MC_HOST" VIEWER_PORT="$VIEWER_PORT" API_PORT="$API_PORT" \
  nohup ./scripts/run-steve-bot.sh "$MC_PORT" > "$LOG_DIR/bot-steve.log" 2>&1 &
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

if [ "${NO_AGENT:-}" = "1" ]; then
  echo "── NO_AGENT=1: skipping agent launch ──"
  exit 0
fi

echo "── starting hermes agent (MC_FORCE_REASON=1) ──"
MC_FORCE_REASON=1 LOG_DIR="$LOG_DIR" \
  nohup ./scripts/run-landfolk-agent.sh \
    Steve "$API_PORT" prompts/landfolk/steve.md "$AGENT_HOME" \
    > "$LOG_DIR/agent-steve.log" 2>&1 &
disown
AGENT_PID=$!
echo "  agent pid: $AGENT_PID"

cat <<EOF

── Steve is running ──
  bot       pid $BOT_PID    on http://localhost:$API_PORT (viewer: http://localhost:$VIEWER_PORT/)
  agent     pid $AGENT_PID

  Live monitor (structured, the recommended view):
    scripts/watch-steve.py                 # tool calls + assistant messages
    scripts/watch-steve.py --reasoning     # include hidden thoughts
    scripts/watch-steve.py --tail 30       # backfill recent history first

  Live monitor (digest pipeline):
    scripts/watch-advise.py                # mc scene/map/find/nearby/advise output

  Raw stdout (debug only, ANSI noise):
    tail -F $LOG_DIR/agent-steve.log
    tail -F $LOG_DIR/bot-steve.log

  Session JSON (canonical):
    ls -t $AGENT_HOME/sessions/ | head -1

EOF
