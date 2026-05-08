#!/usr/bin/env bash
# HermesCraft — goal-directed Gatherer (single bot + Hermes)
#
# Default Minecraft server: 192.168.1.202:25565 (override with MC_HOST / MC_PORT)
#
# Usage:
#   ./start-gatherer.sh MODEL
#   ./start-gatherer.sh MODEL --bots-only
#   ./start-gatherer.sh MODEL --agents-only    # bot already running on API_PORT
#
# Bot only (same defaults; no MODEL / Hermes): scripts/start-gatherer-bot.sh [--daemon] [--kill-port]
# Environment:
#   MC_HOST MC_PORT MC_USERNAME API_PORT MODEL PROVIDER FAIR_PLAY
#   HERMES_SKILLS_ROOT  Optional extra sync target (also syncs into per-agent HERMES_HOME)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR/bot"
BIN_DIR="$SCRIPT_DIR/bin"
PROMPT_FILE="$SCRIPT_DIR/prompts/landfolk/gatherer-test.md"
SOUL_FILE="$SCRIPT_DIR/SOUL-landfolk.md"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
MC_USERNAME="${MC_USERNAME:-Gatherer}"
API_PORT="${API_PORT:-3001}"
PROVIDER="${PROVIDER:-openrouter}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
MONITOR_INTERVAL_S="${MONITOR_INTERVAL_S:-10}"
AUTO_RESUME="${AUTO_RESUME:-true}"
RESTART_SLEEP_S="${RESTART_SLEEP_S:-8}"
MODEL=""
BOTS_ONLY=false
AGENTS_ONLY=false
STARTED_BOT=false
STARTED_MONITOR=false
BOT_PID=""
MONITOR_PID=""

# Optional API keys (same pattern as start-landfolk.sh)
_OR_KEY=$(grep "^OPENROUTER_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
[ -n "$_OR_KEY" ] && export OPENROUTER_API_KEY="$_OR_KEY"
_AN_KEY=$(grep "^ANTHROPIC_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
[ -n "$_AN_KEY" ] && export ANTHROPIC_API_KEY="$_AN_KEY"
unset _OR_KEY _AN_KEY

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bots-only) BOTS_ONLY=true; shift ;;
    --agents-only) AGENTS_ONLY=true; shift ;;
    --port) API_PORT="$2"; shift 2 ;;
    --mc-host) MC_HOST="$2"; shift 2 ;;
    --mc-port) MC_PORT="$2"; shift 2 ;;
    --name) MC_USERNAME="$2"; shift 2 ;;
    --provider) PROVIDER="$2"; shift 2 ;;
    --help|-h)
      echo "Gatherer — supply-focused agent with mc goals / observe / dashboard"
      echo ""
      echo "Usage: ./start-gatherer.sh MODEL [options]"
      echo "       ./start-gatherer.sh MODEL --bots-only"
      echo "       ./start-gatherer.sh MODEL --agents-only"
      echo ""
      echo "Default Minecraft: ${MC_HOST:-192.168.1.202}:${MC_PORT:-25565} (set MC_HOST / MC_PORT to override)"
      echo ""
      echo "Options:"
      echo "  --port N       Bot HTTP API port (default 3001)"
      echo "  --mc-host H    Minecraft server host"
      echo "  --mc-port P    Minecraft server port"
      echo "  --name NAME    Bot username (default Gatherer)"
      echo "  --provider P   Hermes provider (default openrouter)"
      echo "  --bots-only    Start Minecraft bot process only"
      echo "  --agents-only  Start Hermes only (bot must already listen on API_PORT)"
      echo ""
      echo "Env: HERMES_SKILLS_ROOT (optional extra target) — skill is always synced into per-agent HERMES_HOME"
      exit 0 ;;
    -*) echo "Unknown option: $1 (try --help)"; exit 1 ;;
    *) MODEL="$1"; shift ;;
  esac
done

MC_USERNAME_LC="$(printf '%s' "$MC_USERNAME" | tr '[:upper:]' '[:lower:]')"
API_URL="http://localhost:${API_PORT}"

mkdir -p "$LOG_DIR"

cleanup() {
  local ec=$?
  if [ "$STARTED_MONITOR" = true ] && [ -n "${MONITOR_PID:-}" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_BOT" = true ] && [ -n "${BOT_PID:-}" ]; then
    kill "$BOT_PID" 2>/dev/null || true
    echo "  Bot server stopped (PID $BOT_PID)."
  fi
  if [ "$ec" != 0 ] && [ "$ec" != 130 ]; then
    echo "  Exit code: $ec"
  fi
}
trap cleanup EXIT INT TERM

export PATH="$BIN_DIR:$PATH"

# Hermes resolves local skills from $HERMES_HOME/skills/<category>/<name>/SKILL.md.
# We sync into the per-agent home and (optionally) a secondary global root.
HERMES_SKILLS_ROOT="${HERMES_SKILLS_ROOT:-}"
sync_gaming_skill_md() {
  local base="$1"
  local target_root="$2"
  local src="$SCRIPT_DIR/skills/${base}.md"
  local dest_dir="$target_root/gaming/${base}"
  if [ ! -f "$src" ]; then
    echo "  ✗ Missing skill source: $src"; return 1
  fi
  mkdir -p "$dest_dir"
  cp "$src" "$dest_dir/SKILL.md"
}

if [ "$AGENTS_ONLY" = false ]; then
  if [ -z "$MODEL" ] && [ "$BOTS_ONLY" = false ]; then
    echo "Usage: ./start-gatherer.sh MODEL [options]"
    echo "Example: ./start-gatherer.sh deepseek/deepseek-chat-v4-0515"
    exit 1
  fi
  if [ -z "$MODEL" ] && [ "$BOTS_ONLY" = true ]; then
    MODEL="(bots-only)"
  fi
elif [ -z "$MODEL" ]; then
  echo "Usage: ./start-gatherer.sh MODEL --agents-only"
  exit 1
fi

# ── Hermes CLI (needed for full run or agents-only) ──
HERMES=""
if [ "$BOTS_ONLY" = false ]; then
  for c in hermes "$HOME/.local/bin/hermes" /usr/local/bin/hermes; do
    if command -v "$c" &>/dev/null || [ -x "$c" ]; then HERMES="$c"; break; fi
  done
  [ -z "$HERMES" ] && { echo "hermes CLI not found"; exit 1; }
fi

[ -d "$BOT_DIR/node_modules" ] || { echo "Installing bot deps..."; (cd "$BOT_DIR" && npm install --no-audit --no-fund); }

# ── Bot body ──
if [ "$AGENTS_ONLY" = false ]; then
  lsof -ti ":$API_PORT" 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1

  echo ""
  echo "  Gatherer bot → $MC_USERNAME @ $MC_HOST:$MC_PORT (API $API_URL)"
  echo "  Log: $LOG_DIR/bot-${MC_USERNAME_LC}.log"
  echo ""

  (
    cd "$BOT_DIR"
    FAIR_PLAY="${FAIR_PLAY:-true}" \
      MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$MC_USERNAME" API_PORT="$API_PORT" \
      node server.js
  ) > "$LOG_DIR/bot-${MC_USERNAME_LC}.log" 2>&1 &
  BOT_PID=$!
  STARTED_BOT=true

  for _ in $(seq 1 25); do
    curl -sf "$API_URL/health" &>/dev/null && break
    kill -0 "$BOT_PID" 2>/dev/null || { echo "  Bot crashed — see $LOG_DIR/bot-${MC_USERNAME_LC}.log"; exit 1; }
    sleep 1
  done
  echo "  ✓ Bot API up"

  CONN="False"
  for _ in $(seq 1 20); do
    CONN=$(curl -sf "$API_URL/health" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null || echo "False")
    [ "$CONN" = "True" ] && break
    sleep 2
  done
  if [ "$CONN" = "True" ]; then
    echo "  ✓ Connected to Minecraft"
  else
    echo "  ⚠ Not connected yet — server may be down or name in use. Tail log: tail -f $LOG_DIR/bot-${MC_USERNAME_LC}.log"
  fi

  if [ "$BOTS_ONLY" = true ]; then
    echo ""
    echo "  Dashboard: ${API_URL}/dashboard"
    echo "  Other shell: MC_API_URL=$API_URL mc observe"
    echo "  Press Ctrl+C to stop the bot."
    wait "$BOT_PID"
    STARTED_BOT=false
    trap - EXIT INT TERM
    exit 0
  fi
else
  until curl -sf "$API_URL/health" &>/dev/null; do
    echo "  Waiting for bot on $API_URL ..."
    sleep 1
  done
  echo "  ✓ Bot API reachable"
fi

# ── Hermes home + config ──
AGENT_HOME="$HOME/.hermes-gatherer-${MC_USERNAME_LC}"
mkdir -p "$AGENT_HOME/memories" "$AGENT_HOME/sessions"
cp "$SOUL_FILE" "$AGENT_HOME/SOUL.md"
if [ -f "$HOME/.hermes/config.yaml" ]; then
  cp "$HOME/.hermes/config.yaml" "$AGENT_HOME/config.yaml"
  for sedcmd in \
    's/max_iterations: [0-9]*/max_iterations: 500/' \
    's/memory_char_limit: [0-9]*/memory_char_limit: 4400/' \
    's/memory_enabled: false/memory_enabled: true/' \
    's/user_profile_enabled: false/user_profile_enabled: true/'; do
    sed -i '' "$sedcmd" "$AGENT_HOME/config.yaml" 2>/dev/null || sed -i "$sedcmd" "$AGENT_HOME/config.yaml" 2>/dev/null || true
  done
fi
for f in .env auth.json auth.lock; do
  [ -f "$HOME/.hermes/$f" ] && ln -sf "$HOME/.hermes/$f" "$AGENT_HOME/$f" 2>/dev/null || true
done

start_progress_monitor() {
  local monitor_log="$1"
  local api_url="$2"
  local interval="$3"
  (
    while true; do
      TS="$(date '+%Y-%m-%d %H:%M:%S')"
      SNAP="$(curl -sf "$api_url/observe" 2>/dev/null || true)"
      if [ -z "$SNAP" ]; then
        echo "[$TS] monitor: observe unavailable" >> "$monitor_log"
        sleep "$interval"
        continue
      fi
      python3 - "$TS" "$SNAP" >> "$monitor_log" <<'PY'
import json, sys
ts = sys.argv[1]
raw = sys.argv[2]
try:
    o = json.loads(raw)
except Exception as e:
    print(f"[{ts}] monitor: parse error: {e}")
    raise SystemExit(0)

state = o.get("state") or {}
goals = o.get("goals") or []
task = o.get("task") or {}
alerts = o.get("alerts") or []
inv = o.get("inventory_summary") or {}

top = goals[0] if goals else {}
top_id = top.get("id") or "none"
top_u = top.get("urgency")
top_gap = top.get("gap")
task_action = task.get("action") or "-"
task_status = task.get("status") or "-"
checkpoint = task.get("checkpoint_status") or "-"
food = state.get("food")
health = state.get("health")
nearby = state.get("nearby") or {}
hostiles = len(nearby.get("hostiles") or [])
alerts_n = len(alerts)
food_score = inv.get("food_score")

print(
    f"[{ts}] hp={health} food={food} food_score={food_score} "
    f"hostiles={hostiles} alerts={alerts_n} "
    f"top_goal={top_id} urgency={top_u} gap={top_gap} "
    f"task={task_action}/{task_status} checkpoint={checkpoint}"
)
PY
      sleep "$interval"
    done
  ) &
  MONITOR_PID=$!
  STARTED_MONITOR=true
}

RULES="
## ABSOLUTE RULES
- ONLY use \`mc\` to interact with the game. Do not use curl or manual HTTP.
- NEVER run \`mc connect\`.
- Use \`mc tips TOPIC\` when stuck (chest, collect, craft, place, stuck, navigate).
- **Wood / logs:** use any **axe** or **bare hand** (\`mc unequip\`). **Never** mine logs while holding a **pickaxe** or **building blocks** (cobblestone, planks, dirt, stone). Pickaxes are only for stone/ore.
- Before each 1-3 command burst, print one short intent line explaining what you are trying next.
- After any command error, print one short diagnosis line and one next-step line.
"
CHARACTER="$(cat "$PROMPT_FILE")"
FULL_PROMPT="${CHARACTER}

${RULES}

The player in this world is re44 (adjust if the player introduces themselves). Start with: mc goal_load gatherer, then mc observe, then mc goals."

if [ "$BOTS_ONLY" = false ]; then
  for sk in minecraft-goals minecraft-survival minecraft-farming minecraft-building minecraft-combat minecraft-navigation minecraft-planning; do
    if [ -f "$SCRIPT_DIR/skills/${sk}.md" ]; then
      sync_gaming_skill_md "$sk" "$AGENT_HOME/skills"
      [ -n "$HERMES_SKILLS_ROOT" ] && sync_gaming_skill_md "$sk" "$HERMES_SKILLS_ROOT"
    fi
  done
  echo "  ✓ Skills synced to $AGENT_HOME/skills/gaming/"
fi

echo ""
echo "  Hermes:  $MODEL ($PROVIDER)"
echo "  Skills:  minecraft-goals (preloaded) + all mc skills available on-demand"
echo "  Dashboard: ${API_URL}/dashboard"
echo "  Log dir: $LOG_DIR  (tail -f $LOG_DIR/*.log)"
echo "  Agent log: $LOG_DIR/agent-${MC_USERNAME_LC}.log"
echo "  Progress log: $LOG_DIR/progress-${MC_USERNAME_LC}.log (every ${MONITOR_INTERVAL_S}s)"
echo "  MC debug log: $LOG_DIR/mc-${MC_USERNAME_LC}.log (raw CLI requests/responses)"
echo "  Auto-resume: $AUTO_RESUME (sleep ${RESTART_SLEEP_S}s between rounds)"
echo "  Ctrl+C stops this script and the bot."
echo ""

start_progress_monitor "$LOG_DIR/progress-${MC_USERNAME_LC}.log" "$API_URL" "$MONITOR_INTERVAL_S"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] monitor started (interval=${MONITOR_INTERVAL_S}s)" >> "$LOG_DIR/progress-${MC_USERNAME_LC}.log"

# Foreground Hermes loop. This keeps the gatherer alive if a run exits early.
ROUND=0
SESSION_NAME="gatherer-${MC_USERNAME_LC}"
while true; do
  ROUND=$((ROUND + 1))
  if [ "$ROUND" -eq 1 ]; then
    HERMES_HOME="$AGENT_HOME" MC_API_URL="$API_URL" _MC_API_URL_LOCKED="$API_URL" MC_USERNAME="$MC_USERNAME" MC_DEBUG_LOG="$LOG_DIR/mc-${MC_USERNAME_LC}.log" \
      "$HERMES" chat --yolo --max-turns 500 -m "$MODEL" --provider "$PROVIDER" \
      -t terminal,memory -s minecraft-goals \
      -q "$FULL_PROMPT" 2>&1 | tee -a "$LOG_DIR/agent-${MC_USERNAME_LC}.log"
    # Name first session so --continue is deterministic.
    SID=$(grep -oE 'Session: [0-9]{8}_[0-9]{6}_[a-f0-9]+' "$LOG_DIR/agent-${MC_USERNAME_LC}.log" | tail -1 | awk '{print $2}')
    if [ -n "${SID:-}" ]; then
      HERMES_HOME="$AGENT_HOME" "$HERMES" sessions rename "$SID" "$SESSION_NAME" 2>/dev/null || true
    fi
  else
    HERMES_HOME="$AGENT_HOME" MC_API_URL="$API_URL" _MC_API_URL_LOCKED="$API_URL" MC_USERNAME="$MC_USERNAME" MC_DEBUG_LOG="$LOG_DIR/mc-${MC_USERNAME_LC}.log" \
      "$HERMES" chat --yolo --max-turns 500 -m "$MODEL" --provider "$PROVIDER" \
      -t terminal,memory -s minecraft-goals \
      --continue "$SESSION_NAME" \
      -q "Continue gatherer duties from memory. Start with mc anchors, mc observe, mc goals, and mc read_chat. Run trip-based gathering: choose one deficit, set a trip target, gather in batches (not single blocks), return to chest, deposit, then re-evaluate. Use short 3-6 command micro-plans per trip. Before wood trips: mc inventory — equip any axe (\`mc equip …_axe\`) or \`mc unequip\`; do not hold pickaxe or cobblestone/planks for logs. Before stone/ore: equip a pickaxe. Use mc discover logs then mc collect <that_log_type> N (there is no mc collect_wood). Keep/refresh base and source marks; if base mark is missing, discover/confirm and mark it before long trips. Ask the player direct questions when blocked twice. Always narrate intent briefly before command bursts and briefly explain command failures. Reset stale assumptions each round: only report blockers that appear in the latest command output, and never claim JSON issues unless output explicitly says Invalid JSON body." \
      2>&1 | tee -a "$LOG_DIR/agent-${MC_USERNAME_LC}.log"
  fi

  if [ "$AUTO_RESUME" != "true" ]; then
    break
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] gatherer round ${ROUND} exited; restarting in ${RESTART_SLEEP_S}s" >> "$LOG_DIR/agent-${MC_USERNAME_LC}.log"
  sleep "$RESTART_SLEEP_S"
done

STARTED_BOT=false
if [ "$STARTED_MONITOR" = true ] && [ -n "${MONITOR_PID:-}" ]; then
  kill "$MONITOR_PID" 2>/dev/null || true
  STARTED_MONITOR=false
fi
trap - EXIT INT TERM
[ -n "${BOT_PID:-}" ] && kill "$BOT_PID" 2>/dev/null || true
echo "  Done."
