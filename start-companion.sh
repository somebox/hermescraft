#!/usr/bin/env bash
# Start HermesCraft companion with configurable model
# Usage: ./start-companion.sh [model]
# Default model/provider: defaults in data/agent-models.json (optional entrypoints.<key>)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_MODELS_JSON="${AGENT_MODELS_JSON:-$SCRIPT_DIR/data/agent-models.json}"
RESOLVE_AM="$SCRIPT_DIR/scripts/resolve-agent-model.py"

if [[ $# -ge 1 && -n "${1:-}" ]]; then
  MODEL="$1"
  shift
else
  MODEL="$("$RESOLVE_AM" entrypoint companion model "$AGENT_MODELS_JSON")"
fi
PROVIDER="${PROVIDER:-$("$RESOLVE_AM" entrypoint companion provider "$AGENT_MODELS_JSON")}"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
MC_USERNAME="${MC_USERNAME:-HermesBot}"
API_PORT="${API_PORT:-3001}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
MC_USERNAME_LC="$(printf '%s' "$MC_USERNAME" | tr '[:upper:]' '[:lower:]')"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/hermes-${MC_USERNAME_LC}.log"
BOT_LOG="$LOG_DIR/bot-${MC_USERNAME_LC}.log"
MC_DEBUG_LOG="$LOG_DIR/mc-${MC_USERNAME_LC}.log"

export PATH="$SCRIPT_DIR/bin:$PATH"
export MC_API_URL="http://localhost:$API_PORT"
export MC_USERNAME

# Load API keys from hermes .env
# shellcheck disable=SC1091
. "$SCRIPT_DIR/scripts/load-hermes-env.sh"

# Copy SOUL prompt
cp "$SCRIPT_DIR/SOUL-minecraft.md" "$HOME/.hermes/SOUL.md"

# Kill any existing bot server on our port
OLD_PID=$(lsof -ti ":$API_PORT" 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    echo "Killing old bot server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
fi

# Start bot server
echo "Starting bot server ($MC_USERNAME → $MC_HOST:$MC_PORT)..."
cd "$SCRIPT_DIR/bot"
MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$MC_USERNAME" API_PORT="$API_PORT" \
    node server.js > "$BOT_LOG" 2>&1 &
BOT_PID=$!
cd "$SCRIPT_DIR"
trap "kill $BOT_PID 2>/dev/null; echo 'Bot server stopped.'" EXIT

for i in $(seq 1 20); do
    curl -sf "$MC_API_URL/health" &>/dev/null && break
    kill -0 "$BOT_PID" 2>/dev/null || { echo "✗ Bot crashed. See $BOT_LOG"; cat "$BOT_LOG"; exit 1; }
    sleep 1
done

# Wait for MC connection
echo "Waiting for Minecraft connection..."
for i in $(seq 1 15); do
    CONNECTED=$(curl -sf "$MC_API_URL/health" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null || echo "False")
    [ "$CONNECTED" = "True" ] && break
    sleep 2
done

if [ "$CONNECTED" = "True" ]; then
    echo "✓ $MC_USERNAME is in the game!"
else
    echo "⚠ Bot server running but not connected to MC yet (will auto-retry)"
fi

echo "Model:  $MODEL"
echo "Log dir: $LOG_DIR  (tail -f $LOG_DIR/*.log)"
echo "Hermes: $LOG"
echo "Bot:    $BOT_LOG"
echo "MC CLI: $MC_DEBUG_LOG"
echo "─────────────────────────────"

INITIAL_PROMPT="You're playing Minecraft with a friend. You control a bot via the mc CLI in your terminal.

## How to play
1. Run mc status — see health, inventory, position, nearby blocks/entities, and chat
2. Decide what to do based on what you see
3. Run ONE mc command
4. Run mc status again. Repeat forever.

## ABSOLUTE RULES (never break these)
- NEVER break blocks that are part of a building — no walls, windows, glass, floors, roofs. Use the DOOR to enter: mc interact X Y Z on the door block.
- NEVER take crafting tables, furnaces, or chests from buildings. If you need one, CRAFT YOUR OWN.
- NEVER run mc connect — it will crash the bot.
- NEVER retry a failed command more than once — try something different instead.
- If stuck on a verb, run mc help to list available commands; for higher-level patterns load a skill (skill_view minecraft-survival, minecraft-navigation, etc.)
- Read coordinates from mc status and mc nearby output — do not guess coordinates
- Before placing blocks: mc equip BLOCK first, then mc place BLOCK X Y Z
- Check mc inventory after crafting to confirm results

## Situational awareness
- Your Y position tells you where you are: Y=62-70 is surface, Y<58 means underground/cave, Y>100 is a mountain
- If you are underground (low Y, seeing stone/ores/dirt): mc goto X 80 Z to pathfind to surface, or dig up
- If mc scene shows very few blocks or only stone: you are stuck in terrain — move or dig out
- If mc collect or mc find_blocks fails: you cannot see the block. Use mc nearby 32 to find coordinates, mc goto_near X Y Z to walk there, THEN collect
- If navigation fails: mc stop first, then try mc goto_near instead of mc goto, or try different coordinates
- mc look gives a natural language description of surroundings — use it when disoriented
- mc map 16 shows an ASCII top-down map — use it to understand the terrain layout
- ALWAYS check mc status after moving to verify your new position and what is around you

## Exact block names (use these, not abbreviations)
Wood: oak_log, birch_log, spruce_log. Ores: coal_ore, iron_ore, diamond_ore (NOT coal, iron, diamond).
Smelting: raw_iron -> iron_ingot. Drops: coal (from coal_ore), diamond (from diamond_ore).

## Survival progression
Phase 1: mc collect oak_log 4 -> mc craft oak_planks -> mc craft stick -> mc craft crafting_table -> place it -> mc craft wooden_pickaxe -> mc collect cobblestone 20 -> mc craft stone_pickaxe + mc craft stone_sword -> mc craft furnace -> place it -> collect coal_ore -> mc craft torch
Phase 2: mc collect iron_ore 11 -> mc smelt raw_iron -> mc craft iron_pickaxe + iron_sword + shield + bucket

## Companion duties
- Follow the player and find where they are setting up. Mark it: mc mark home
- Make sure there is a crafting_table, chest, and furnace near home. If not, craft and place them.
- Deposit extra resources in the chest. Return to base after gathering.
- Talk to the player: mc chat \"message\". Check for messages: mc read_chat. Respond promptly.

Start now by running mc status."

SESSION_NAME="hermescraft-companion"
ROUND=0
SESSION_ID=""

CONTINUE_PROMPT="You're still playing Minecraft with your friend. Your session was interrupted but you're back now.
Run mc status to see where you are, check mc read_chat for any messages, then keep playing.
Remember: mc help lists verbs; skill_view minecraft-<topic> for patterns."

while true; do
    ROUND=$((ROUND + 1))
    echo ""
    echo "═══ Round $ROUND ($(date +%H:%M:%S)) ═══"

    if [ "$ROUND" -eq 1 ]; then
        MC_DEBUG_LOG="$MC_DEBUG_LOG" hermes chat --yolo --max-turns 500 -m "$MODEL" --provider "$PROVIDER" \
            -q "$INITIAL_PROMPT" 2>&1 | tee -a "$LOG"

        # Extract session ID for resumption
        SESSION_ID=$(grep -oE 'Session: [0-9]{8}_[0-9]{6}_[a-f0-9]+' "$LOG" | tail -1 | cut -d' ' -f2)
        if [ -n "$SESSION_ID" ]; then
            hermes sessions rename "$SESSION_ID" "$SESSION_NAME" 2>/dev/null || true
            echo "  Session: $SESSION_ID (named: $SESSION_NAME)"
        fi
    else
        # Resume previous session with context preserved
        MC_DEBUG_LOG="$MC_DEBUG_LOG" hermes chat --yolo --max-turns 500 -m "$MODEL" --provider "$PROVIDER" \
            --continue "$SESSION_NAME" \
            -q "$CONTINUE_PROMPT" 2>&1 | tee -a "$LOG"
    fi

    echo ""
    echo "  ⟳ Round $ROUND complete. Resuming in 5s... (Ctrl+C to stop)"
    sleep 5
done
