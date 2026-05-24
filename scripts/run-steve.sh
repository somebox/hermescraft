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
#   AGENT_ONLY=1  (skip the bot kill/restart — leave the running bot alone,
#                  only restart the Hermes brain. Preserves the bot's in-process
#                  chat buffer so the new agent session sees recent whispers.)
#   SUPERVISE=1   (after launching the agent, wait + respawn on exit. The bot
#                  stays up regardless, so chat history survives turn-end exits.
#                  Stop with Ctrl-C or `pkill -f run-landfolk-agent.sh`.)

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

# Kill any existing agent (always — that's the point of restarting).
echo "── stopping any existing Steve agent ──"
pkill -f 'run-landfolk-agent.sh Steve' 2>/dev/null || true
pkill -f 'hermes chat.*hermes-landfolk-steve' 2>/dev/null || true

if [ "${AGENT_ONLY:-}" = "1" ]; then
  echo "── AGENT_ONLY=1: leaving bot alive ──"
  # Confirm bot is actually running, else fall through to full restart.
  if ! curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
    echo "  bot not responding on :$API_PORT — falling back to full restart"
    AGENT_ONLY=
  fi
fi

if [ "${AGENT_ONLY:-}" != "1" ]; then
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
else
  BOT_PID=$(lsof -ti tcp:"$API_PORT" 2>/dev/null | head -1)
  echo "  bot pid: ${BOT_PID:-unknown} (kept alive)"
fi

if [ "${NO_AGENT:-}" = "1" ]; then
  echo "── NO_AGENT=1: skipping agent launch ──"
  exit 0
fi

launch_agent() {
  echo "── starting hermes agent (MC_FORCE_REASON=1) ──"
  MC_FORCE_REASON=1 LOG_DIR="$LOG_DIR" \
    ./scripts/run-landfolk-agent.sh \
      Steve "$API_PORT" prompts/landfolk/steve.md "$AGENT_HOME"
}

if [ "${SUPERVISE:-}" = "1" ]; then
  echo "── SUPERVISE=1: respawning agent on exit (Ctrl-C to stop) ──"
  trap 'echo "── supervisor stopping ──"; exit 0' INT TERM
  attempt=1
  while true; do
    echo "── supervisor: agent attempt #$attempt ──"
    launch_agent >> "$LOG_DIR/agent-steve.log" 2>&1 || true
    echo "── supervisor: agent exited; relaunching in 3s ──" | tee -a "$LOG_DIR/agent-steve.log"
    sleep 3
    attempt=$((attempt + 1))
  done
fi

nohup bash -c "$(declare -f launch_agent); launch_agent" \
  > "$LOG_DIR/agent-steve.log" 2>&1 &
disown
AGENT_PID=$!
echo "  agent pid: $AGENT_PID"

cat <<EOF

── Steve is running ──
  bot       pid ${BOT_PID:-?}    on http://localhost:$API_PORT (viewer: http://localhost:$VIEWER_PORT/)
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

  Ping (wake) Steve without disrupting the bot:
    AGENT_ONLY=1 ./scripts/run-steve.sh   # restart brain, bot keeps chat buffer

  Auto-respawn the brain on exit (keeps the bot alive between sessions):
    AGENT_ONLY=1 SUPERVISE=1 ./scripts/run-steve.sh

EOF
