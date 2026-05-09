#!/usr/bin/env bash
# HermesCraft Landfolk — 5 characters helping build a community
# Adapted for ubuntu-host server + OpenRouter
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR/bot"
BIN_DIR="$SCRIPT_DIR/bin"
PROMPT_DIR="$SCRIPT_DIR/prompts/landfolk"
SOUL_FILE="$SCRIPT_DIR/SOUL-landfolk.md"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
BASE_API_PORT=3001
MODEL=""
PROVIDER=""
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
BOTS_ONLY=false
AGENTS_ONLY=false

# Load API keys
_OR_KEY=$(grep "^OPENROUTER_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
[ -n "$_OR_KEY" ] && export OPENROUTER_API_KEY="$_OR_KEY"
_AN_KEY=$(grep "^ANTHROPIC_API_KEY=" "$HOME/.hermes/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)
[ -n "$_AN_KEY" ] && export ANTHROPIC_API_KEY="$_AN_KEY"
unset _OR_KEY _AN_KEY

AGENT_MODELS_JSON="${AGENT_MODELS_JSON:-$SCRIPT_DIR/data/agent-models.json}"
RESOLVE_AM="$SCRIPT_DIR/scripts/resolve-agent-model.py"
CLI_EXAMPLE="$("$RESOLVE_AM" defaults model "$AGENT_MODELS_JSON" 2>/dev/null || printf '%s' '')"

AGENTS=()
while IFS= read -r line; do
  [ -n "${line:-}" ] && AGENTS+=("$line")
done < <("$RESOLVE_AM" roster-lines "$AGENT_MODELS_JSON")

PIDS=()
BOT_PIDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bots-only) BOTS_ONLY=true; shift ;;
    --agents-only) AGENTS_ONLY=true; shift ;;
    --port) MC_PORT="$2"; shift 2 ;;
    --help|-h)
      echo "Landfolk — multi-character launcher (roster: agents.* with \"role\" in data/agent-models.json)"
      echo "Usage: ./start-landfolk.sh [MODEL] [--bots-only] [--agents-only] [--port PORT]"
      echo "MODEL defaults to defaults.model from data/agent-models.json if omitted."
      if [ -n "$CLI_EXAMPLE" ]; then
        echo "Example: ./start-landfolk.sh $CLI_EXAMPLE"
      fi
      exit 0 ;;
    -*) echo "Unknown option: $1"; exit 1 ;;
    *) MODEL="$1"; shift ;;
  esac
done

MODEL="${MODEL:-$("$RESOLVE_AM" defaults model "$AGENT_MODELS_JSON")}"
PROVIDER="${PROVIDER:-$("$RESOLVE_AM" defaults provider "$AGENT_MODELS_JSON")}"

if [ "${#AGENTS[@]}" -eq 0 ]; then
  echo "ERROR: no roster lines — add agents with a \"role\" field in ${AGENT_MODELS_JSON}"
  exit 1
fi
mkdir -p "$LOG_DIR"

cleanup() {
  echo ""
  echo "  Stopping landfolk..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  if [ "$AGENTS_ONLY" = false ]; then
    for pid in "${BOT_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  fi
  wait 2>/dev/null || true
  echo "  All stopped."
}
trap cleanup EXIT INT TERM

export PATH="$BIN_DIR:$PATH"

HERMES=""
for c in hermes "$HOME/.local/bin/hermes" /usr/local/bin/hermes; do
  if command -v "$c" &>/dev/null || [ -x "$c" ]; then HERMES="$c"; break; fi
done
[ -z "$HERMES" ] && { echo "hermes CLI not found"; exit 1; }

[ -d "$BOT_DIR/node_modules" ] || { echo "Installing bot deps..."; cd "$BOT_DIR" && npm install --no-audit --no-fund; cd "$SCRIPT_DIR"; }

echo ""
echo "  ⚡ HermesCraft Landfolk"
echo "  Model:  $MODEL"
echo "  Server: $MC_HOST:$MC_PORT"
echo "  Logs:   $LOG_DIR/"
echo ""

# ── Start bot bodies ──
if [ "$AGENTS_ONLY" = false ]; then
  echo "Starting bot bodies..."
  for i in "${!AGENTS[@]}"; do
    IFS=':' read -r name role agent_model <<< "${AGENTS[$i]}"
    PORT=$((BASE_API_PORT + i))
    name_lower="${name,,}"

    # Kill any existing bot on this port
    lsof -ti ":$PORT" 2>/dev/null | xargs kill 2>/dev/null || true

    cd "$BOT_DIR"
    FAIR_PLAY="${FAIR_PLAY:-true}" \
      MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$name" API_PORT="$PORT" \
      node server.js > "$LOG_DIR/bot-${name_lower}.log" 2>&1 &
    BOT_PIDS+=($!)
    cd "$SCRIPT_DIR"
    echo "  🤖 $name bot → port $PORT"
    sleep 3
  done

  # Wait for connections
  echo "Waiting for bots to connect..."
  sleep 5
  FAILED=()
  for i in "${!AGENTS[@]}"; do
    IFS=':' read -r name role agent_model <<< "${AGENTS[$i]}"
    PORT=$((BASE_API_PORT + i))
    CONN=$(curl -sf "http://localhost:$PORT/health" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null || echo "False")
    if [ "$CONN" = "True" ]; then
      echo "  ✓ $name connected"
    else
      FAILED+=("$name")
      echo "  ✗ $name failed to connect (see $LOG_DIR/bot-${name,,}.log)"
    fi
  done
  if [ ${#FAILED[@]} -gt 0 ]; then
    echo ""
    echo "  Some bots failed. Check logs. Continuing with connected bots..."
  fi
fi

[ "$BOTS_ONLY" = true ] && { echo ""; echo "Bots ready. Ctrl+C to stop."; wait; exit 0; }

# ── Community prompt shared by all agents ──
COMMUNITY_RULES="
## ABSOLUTE RULES
- ONLY use mc commands to interact with the game. Do NOT use curl, node, python, or any other commands. The bot is already running and connected for you.
- NEVER break blocks that are part of a building — no walls, windows, glass, floors, roofs, fences. Use DOORS to enter: mc interact X Y Z
- NEVER take crafting tables, furnaces, or chests from buildings. If you need one, CRAFT YOUR OWN.
- NEVER run mc connect — it will crash your bot.
- Use mc tips TOPIC when stuck (chest, collect, craft, place, stuck, navigate).

## Community duties
- There is a shared home base. Find the player and other characters. Mark home: mc mark home
- Deposit resources you gather into the community chest. Check mc nearby for chest coordinates.
- Use mc deposit ITEM X Y Z to put items in the chest. Use mc chest X Y Z to see contents.
- If there is no crafting table, chest, or furnace at base, craft and place one.
- Help build and improve the shared house — add walls, roof, doors, torches, beds.
- Coordinate with other characters. Read chat often. Share what you find.
- Before placing blocks: mc equip BLOCK first, then mc place BLOCK X Y Z.
- Use exact block names: oak_log (not oak), coal_ore (not coal), iron_ore (not iron).
- Check mc inventory after crafting. Check mc status after moving.

## Getting help
Run mc tips TOPIC for step-by-step help: chest, collect, craft, place, stuck, navigate"

# ── Launch agents ──
echo ""
echo "Launching agents..."
for i in "${!AGENTS[@]}"; do
  IFS=':' read -r name role agent_model <<< "${AGENTS[$i]}"
  name_lower="${name,,}"
  PORT=$((BASE_API_PORT + i))
  AGENT_HOME="$HOME/.hermes-landfolk-${name_lower}"
  PROMPT_FILE="$PROMPT_DIR/${name_lower}.md"

  # Set up agent home
  mkdir -p "$AGENT_HOME/memories" "$AGENT_HOME/sessions"
  cp "$SOUL_FILE" "$AGENT_HOME/SOUL.md"
  if [ -f "$HOME/.hermes/config.yaml" ]; then
    cp "$HOME/.hermes/config.yaml" "$AGENT_HOME/config.yaml"
    # Increase max turns and memory limit
    for sedcmd in \
      's/max_iterations: [0-9]*/max_iterations: 500/' \
      's/memory_char_limit: [0-9]*/memory_char_limit: 4400/' \
      's/memory_enabled: false/memory_enabled: true/' \
      's/user_profile_enabled: false/user_profile_enabled: true/'; do
      sed -i '' "$sedcmd" "$AGENT_HOME/config.yaml" 2>/dev/null || \
      sed -i "$sedcmd" "$AGENT_HOME/config.yaml" 2>/dev/null || true
    done
  fi
  for f in .env auth.json auth.lock; do
    [ -f "$HOME/.hermes/$f" ] && ln -sf "$HOME/.hermes/$f" "$AGENT_HOME/$f" 2>/dev/null || true
  done

  # Seed memory with essential knowledge on first run
  MEMORY_FILE="$AGENT_HOME/memories/MEMORY.md"
  if ! grep -q "mc tips" "$MEMORY_FILE" 2>/dev/null; then
    cat >> "$MEMORY_FILE" << 'SEED'
§
ESSENTIAL: Use mc tips TOPIC for help (chest, collect, craft, place, stuck, navigate). Use exact block names: oak_log not oak, coal_ore not coal. Equip blocks before placing. Crafting table needed for tools. Never break building blocks — use doors.
§
COMMANDS: mc status (observe), mc nearby 32 (find blocks+coords), mc goto_near X Y Z (move), mc collect BLOCK N (gather), mc craft ITEM (craft near table), mc deposit ITEM X Y Z (chest), mc chat "msg" (talk), mc tips TOPIC (help).
SEED
    echo "  Seeded memory for $name"
  fi

  # Build the full prompt: character personality + community rules
  CHARACTER_PROMPT=$(cat "$PROMPT_FILE")
  FULL_PROMPT="${CHARACTER_PROMPT}

${COMMUNITY_RULES}

The player in this world is re44. Start by running mc status."

  # Use per-agent model if specified, otherwise fall back to global MODEL
  AGENT_MODEL="${agent_model:-$MODEL}"

  # Sync all mc skills for on-demand loading
  for sk in minecraft-survival minecraft-farming minecraft-building minecraft-combat minecraft-navigation minecraft-planning; do
    local_src="$SCRIPT_DIR/skills/${sk}.md"
    if [ -f "$local_src" ]; then
      sk_dest="$AGENT_HOME/skills/gaming/${sk}"
      mkdir -p "$sk_dest"
      cp "$local_src" "$sk_dest/SKILL.md"
    fi
  done

  # Builder roles preload minecraft-building; others load skills on-demand
  HERMES_COMMON=(chat --yolo --max-turns 500 -m "$AGENT_MODEL" --provider "$PROVIDER" -t terminal,memory)
  if [ "$role" = "builder" ]; then
    HERMES_COMMON+=(-s minecraft-building)
  fi

  # Launch in a loop so agents restart when they hit max turns
  (
    ROUND=0
    SESSION_NAME="landfolk-${name_lower}"
    while true; do
      ROUND=$((ROUND + 1))
      if [ "$ROUND" -eq 1 ]; then
        HERMES_HOME="$AGENT_HOME" MC_API_URL="http://localhost:$PORT" _MC_API_URL_LOCKED="http://localhost:$PORT" MC_USERNAME="$name" \
          "$HERMES" "${HERMES_COMMON[@]}" \
          -q "$FULL_PROMPT" >> "$LOG_DIR/agent-${name_lower}.log" 2>&1

        # Name the session for future --continue
        SID=$(grep -oE 'Session: [0-9]{8}_[0-9]{6}_[a-f0-9]+' "$LOG_DIR/agent-${name_lower}.log" | tail -1 | cut -d' ' -f2)
        [ -n "$SID" ] && HERMES_HOME="$AGENT_HOME" "$HERMES" sessions rename "$SID" "$SESSION_NAME" 2>/dev/null || true
      else
        HERMES_HOME="$AGENT_HOME" MC_API_URL="http://localhost:$PORT" _MC_API_URL_LOCKED="http://localhost:$PORT" MC_USERNAME="$name" \
          "$HERMES" "${HERMES_COMMON[@]}" \
          --continue "$SESSION_NAME" \
          -q "You're back in Minecraft (round $ROUND). Check your memory for what you were doing. Run mc status and mc read_chat. Review mc marks for saved locations. Continue helping the community." \
          >> "$LOG_DIR/agent-${name_lower}.log" 2>&1
      fi
      echo "[$(date +%H:%M:%S)] $name round $ROUND complete, restarting..." >> "$LOG_DIR/agent-${name_lower}.log"
      sleep 10
    done
  ) &
  PIDS+=($!)
  echo "  🧠 $name ($role) → port $PORT | model: $AGENT_MODEL | log: $LOG_DIR/agent-${name_lower}.log"
  sleep 5  # stagger agent launches
done

echo ""
echo "═══════════════════════════════════════"
echo "  All landfolk launched!"
echo "  Logs: tail -f $LOG_DIR/agent-*.log"
echo "  Bots: tail -f $LOG_DIR/bot-*.log"
echo "  Press Ctrl+C to stop all."
echo "═══════════════════════════════════════"
echo ""

wait
