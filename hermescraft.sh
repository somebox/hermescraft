#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# hermescraft — Start Hermes playing Minecraft
#
# Usage:
#   ./hermescraft.sh                       # uses cheap default from data/agent-models.json
#   HERMES_MODEL=deepseek/deepseek-v4-flash ./hermescraft.sh
#   ./hermescraft.sh --model deepseek/deepseek-v4-flash "build me a castle"
#   ./hermescraft.sh --bot-only            # bot only — no LLM (no model needed)
#
# Environment:
#   MC_HOST      Minecraft server host (default: localhost)
#   MC_PORT      Minecraft server port (default: 25565)
#   MC_USERNAME  Bot name (default: HermesBot)
#   HERMES_MODEL Optional. Defaults to data/agent-models.json defaults.model
#                (currently deepseek/deepseek-v4-flash). Override carefully —
#                claude-sonnet-4 is ~30× more expensive.
#   HERMES_PROVIDER Provider for hermes chat (default: openrouter or
#                data/agent-models.json defaults.provider).
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load API keys from hermes .env so subprocesses inherit them. (Claude Code
# clears ANTHROPIC_API_KEY in child shells, so we re-export explicitly.)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/scripts/load-hermes-env.sh"

# #98: also source the repo-local .env (PAPERMCP_TOKEN lives here, not in
# ~/.hermes/.env). Without this, paperMcpConfig() returns null and the
# craft-fallback path in bot/lib/actions/crafting.js can't fire — which
# is exactly the Paper-1.21 oak_fence repro from Steve's chicken-pen task.
# `set -a` exports every variable assigned by the .env file so the node
# child inherits PAPERMCP_TOKEN.
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$SCRIPT_DIR/.env"
    set +a
fi
BOT_DIR="$SCRIPT_DIR/bot"
BIN_DIR="$SCRIPT_DIR/bin"

MC_HOST="${MC_HOST:-localhost}"
MC_PORT="${MC_PORT:-25565}"
MC_USERNAME="${MC_USERNAME:-HermesBot}"
API_PORT="${API_PORT:-3001}"
# API_URL is set after arg parsing (see below)

BOT_ONLY=false
GOAL=""
SOUL_BACKUP=""
SOUL_OVERRIDE=""
BOT_PID=""
MODEL=""
PROVIDER=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --bot-only) BOT_ONLY=true; shift ;;
        --name) MC_USERNAME="$2"; shift 2 ;;
        --port) API_PORT="$2"; shift 2 ;;
        --soul) SOUL_OVERRIDE="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --provider) PROVIDER="$2"; shift 2 ;;
        --help|-h)
            echo "hermescraft — Hermes plays Minecraft with you"
            echo ""
            echo "Usage: ./hermescraft.sh [options] [goal]"
            echo "       HERMES_MODEL=deepseek/deepseek-v4-flash ./hermescraft.sh [goal]"
            echo "       ./hermescraft.sh --bot-only"
            echo ""
            echo "Options:"
            echo "  --name NAME       Set bot username (default: HermesBot)"
            echo "  --port PORT       Set API port (default: 3001)"
            echo "  --soul FILE       Use custom SOUL file instead of SOUL-minecraft.md"
            echo "  --model SLUG      LLM id (overrides HERMES_MODEL)"
            echo "  --provider NAME   hermes --provider (default: openrouter, or HERMES_PROVIDER)"
            echo "  --bot-only        Start bot server only (no Hermes agent)"
            echo "  --help, -h        Show this help"
            echo ""
            echo "Environment:"
            echo "  MC_HOST           Minecraft server host (default: localhost)"
            echo "  MC_PORT           Minecraft server port (default: 25565)"
            echo "  MC_USERNAME       Bot name (default: HermesBot)"
            echo "  API_PORT          Bot API port (default: 3001)"
            echo "  VIEWER_PORT       Optional prismarine-viewer FPV web port (e.g. 4001; dashboard iframe)"
            echo "  HERMES_MODEL      LLM model slug (default: data/agent-models.json defaults.model = deepseek/deepseek-v4-flash)"
            echo "  HERMES_PROVIDER   Optional (default: openrouter)"
            echo "  AUTO_RESUME       If true (default), restart Hermes after each round (required because"
            echo "                    \`hermes chat -q\` exits after one agent turn). Set false for a single turn."
            echo "  RESTART_SLEEP_S   Seconds between rounds when AUTO_RESUME is true (default: 5)"
            echo "  LOG_DIR           Agent log directory (default: /tmp/hermescraft)"
            exit 0 ;;
        *) GOAL="$1"; shift ;;
    esac
done

LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
MC_USERNAME_LC="$(printf '%s' "$MC_USERNAME" | tr '[:upper:]' '[:lower:]')"
mkdir -p "$LOG_DIR"
BOT_LOG="$LOG_DIR/bot-${MC_USERNAME_LC}.log"

MODEL="${HERMES_MODEL:-${MODEL:-}}"
PROVIDER="${HERMES_PROVIDER:-${PROVIDER:-openrouter}}"

# Context compaction. On continue rounds we swap the long prompt for a
# short one and cap tool calls per round (HERMES_MAX_TURNS) so the
# session pages out before context bloats.
CONTEXT_MINIMAL_CONTINUE="${CONTEXT_MINIMAL_CONTINUE:-true}"
CONTEXT_REFRESH_EVERY_ROUNDS="${CONTEXT_REFRESH_EVERY_ROUNDS:-24}"
HERMES_MAX_TURNS="${HERMES_MAX_TURNS:-100}"

# Scope the system-prompt `<available_skills>` list to just the
# Minecraft skills Steve actually uses. Hermes reads
# `skills.platform_disabled.hermescraft` from ~/.hermes/config.yaml
# when HERMES_PLATFORM=hermescraft, dropping all unrelated skills
# (apple-notes, songsee, audiocraft, …) from every request. Saves
# ~2,800 tokens/call. See agent/skill_utils.py:get_disabled_skill_names.
export HERMES_PLATFORM="${HERMES_PLATFORM:-hermescraft}"

# Fall back to the cheap default in data/agent-models.json when neither
# --model nor HERMES_MODEL is set. This prevents the previous failure mode
# where a user copying the help text would launch on claude-sonnet-4
# (~30× the cost of the deepseek default). Override via env or --model.
if [ "$BOT_ONLY" != true ] && [ -z "$MODEL" ]; then
    MODELS_JSON="$SCRIPT_DIR/data/agent-models.json"
    if [ -f "$MODELS_JSON" ]; then
        DEFAULT_MODEL=$(python3 -c "import json; d=json.load(open('$MODELS_JSON')); print(d['defaults']['model'])" 2>/dev/null || echo "")
        DEFAULT_PROVIDER=$(python3 -c "import json; d=json.load(open('$MODELS_JSON')); print(d['defaults']['provider'])" 2>/dev/null || echo "")
        if [ -n "$DEFAULT_MODEL" ]; then
            MODEL="$DEFAULT_MODEL"
            if [ -z "${HERMES_PROVIDER:-}" ] && [ -n "$DEFAULT_PROVIDER" ]; then
                PROVIDER="$DEFAULT_PROVIDER"
            fi
            echo "  ℹ Using default model $MODEL ($PROVIDER) from data/agent-models.json"
        fi
    fi
fi

# Set API_URL after arg parsing so --port takes effect
API_URL="http://localhost:$API_PORT"

if [ "$BOT_ONLY" != true ] && [ -z "$MODEL" ]; then
    echo "  ✗ No LLM model set and no default in data/agent-models.json."
    echo "    Set HERMES_MODEL or pass --model, e.g.:"
    echo "      HERMES_MODEL=deepseek/deepseek-v4-flash ./hermescraft.sh"
    echo "      ./hermescraft.sh --model anthropic/claude-sonnet-4 --provider openrouter   # expensive!"
    exit 1
fi

# Cleanup on exit
cleanup() {
    [ -n "$BOT_PID" ] && kill "$BOT_PID" 2>/dev/null && echo "  Bot server stopped."
    [ -n "$SOUL_BACKUP" ] && [ -f "$SOUL_BACKUP" ] && mv "$SOUL_BACKUP" "$HOME/.hermes/SOUL.md"
    echo "  Hermes has left the game."
}
trap cleanup EXIT INT TERM

echo ""
echo "  ⚡ HermesCraft v3"
echo ""

# Check prerequisites
command -v node &>/dev/null || { echo "  ✗ Need Node.js (v18+)"; exit 1; }
[ -d "$BOT_DIR/node_modules" ] || { echo "  Installing bot dependencies..."; cd "$BOT_DIR" && npm install --no-audit --no-fund 2>&1 | tail -2; cd "$SCRIPT_DIR"; }

# Put mc on PATH
export PATH="$BIN_DIR:$PATH"
export MC_API_URL="$API_URL"
export MC_USERNAME

# Symlink mc to ~/.local/bin if not there
[ -L "$HOME/.local/bin/mc" ] || { mkdir -p "$HOME/.local/bin"; ln -sf "$BIN_DIR/mc" "$HOME/.local/bin/mc" 2>/dev/null || true; }

# Start bot server if not already running
if curl -sf "$API_URL/health" &>/dev/null; then
    echo "  ✓ Bot server already running"
else
    echo "  Starting bot server ($MC_USERNAME → $MC_HOST:$MC_PORT)..."
    cd "$BOT_DIR"
    [ -n "${VIEWER_PORT:-}" ] && export VIEWER_PORT
    FAIR_PLAY="${FAIR_PLAY:-true}" \
      MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$MC_USERNAME" API_PORT="$API_PORT" \
      node server.js > "$BOT_LOG" 2>&1 &
    BOT_PID=$!
    cd "$SCRIPT_DIR"

    # Wait for it
    for i in $(seq 1 20); do
        curl -sf "$API_URL/health" &>/dev/null && break
        kill -0 "$BOT_PID" 2>/dev/null || { echo "  ✗ Bot crashed. Check $BOT_LOG"; exit 1; }
        sleep 1
    done
    echo "  ✓ Bot server ready (PID $BOT_PID)"
fi

# Wait for MC connection
echo "  Connecting to Minecraft..."
for i in $(seq 1 15); do
    CONNECTED=$(curl -sf "$API_URL/health" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null || echo "False")
    [ "$CONNECTED" = "True" ] && break
    sleep 2
done

if [ "$CONNECTED" = "True" ]; then
    echo "  ✓ $MC_USERNAME is in the game!"
else
    echo "  ⚠ Bot couldn't connect to Minecraft at $MC_HOST:$MC_PORT"
    echo "    Make sure Minecraft is running and the port is correct."
    echo "    Bot server is still running — it'll auto-reconnect when MC is ready."
fi

if [ "$BOT_ONLY" = true ]; then
    echo ""
    echo "  Bot server running. Try: mc status / mc chat 'hello'"
    echo "  Bot log: $BOT_LOG"
    echo "  Press Ctrl+C to stop."
    wait "$BOT_PID" 2>/dev/null
    exit 0
fi

# Find hermes
HERMES=""
for c in hermes "$HOME/.local/bin/hermes" /usr/local/bin/hermes; do
    if command -v "$c" &>/dev/null || [ -x "$c" ]; then HERMES="$c"; break; fi
done
[ -z "$HERMES" ] && { echo "  ✗ hermes CLI not found. pip install hermes-agent"; exit 1; }

# Swap SOUL.md temporarily
SOUL_FILE="$HOME/.hermes/SOUL.md"
if [ -f "$SOUL_FILE" ]; then
    SOUL_BACKUP="$SOUL_FILE.hermescraft-bak"
    cp "$SOUL_FILE" "$SOUL_BACKUP"
fi
if [ -n "$SOUL_OVERRIDE" ] && [ -f "$SOUL_OVERRIDE" ]; then
    cp "$SOUL_OVERRIDE" "$SOUL_FILE"
else
    cp "$SCRIPT_DIR/SOUL-minecraft.md" "$SOUL_FILE"
fi

# Sync mc skills for on-demand loading via skill_view().
# Canonical list lives in skills/MANIFEST.
HERMES_SKILLS_DIR="$HOME/.hermes/skills/gaming"
QUIET=1 "$SCRIPT_DIR/scripts/sync-skills.sh" "$HERMES_SKILLS_DIR"

AUTO_RESUME="${AUTO_RESUME:-true}"
RESTART_SLEEP_S="${RESTART_SLEEP_S:-5}"
SESSION_NAME="hermescraft-${MC_USERNAME_LC}"
# #90: session-ID file (per bot) — round-1 captures the actual session
# ID, rounds 2+ pass it to `--continue` exactly. Avoids the prefix-match
# bug where renamed archived sessions like `hermescraft-steve-archived-*`
# would shadow `--continue hermescraft-steve`.
SESSION_ID_FILE="$LOG_DIR/session-${MC_USERNAME_LC}.id"
SESSION_ID=""
AGENT_LOG="$LOG_DIR/hermes-${MC_USERNAME_LC}.log"
MC_DEBUG_LOG="$LOG_DIR/mc-${MC_USERNAME_LC}.log"

echo ""
echo "  ═══════════════════════════════════════"
echo "  Model:   $MODEL ($PROVIDER)"
[ -n "$GOAL" ] && echo "  Goal: $GOAL"
echo "  Talk to Hermes in Minecraft chat!"
echo "  Say: hermes follow me / hermes build a house"
echo "  Auto-resume: ${AUTO_RESUME:-true} (hermes -q exits after each turn; script starts the next round)"
[ "${AUTO_RESUME:-true}" = "true" ] && echo "  Logs: $LOG_DIR/ (hermes-*.log, mc-*.log; bot: bot-${MC_USERNAME_LC}.log)"
echo "  ═══════════════════════════════════════"
echo ""

# Build the prompt
if [ -n "$GOAL" ]; then
    PROMPT="You're in Minecraft. Your goal: $GOAL

You have the \`mc\` CLI to control your bot. Run \`mc status\` to see where you are, what's around, and if the player said anything. Chat with the player via \`mc chat \"message\"\`. Check \`mc commands\` for requests they made in-game.

Start by running \`mc status\` to see the world. Within this round use as many tool calls as needed; when you reply, this process will start another round automatically — keep playing across rounds."
else
    PROMPT="You're in Minecraft with a friend. You have the \`mc\` CLI to control your bot.

## Loop structure (follow this every round)
1. OBSERVE: \`mc status\`, \`mc read_chat\`, \`mc commands\`, \`mc goals\` (if goals are empty, run \`mc goal_load gatherer\` first)
2. PLAN: Pick the highest-urgency goal (from \`mc goals\`). State your plan in one line.
3. ACT: Execute 3-8 commands toward that goal, then re-observe.
4. REPEAT until the turn ends. Never idle — always make progress.

## Tool rules
- **Wood:** equip any \`…_axe\` (or \`mc unequip\` for bare hand). Never use a pickaxe for logs.
- **Stone/ore:** equip a pickaxe first.
- **Crafting:** items needing a 3x3 grid (tools, weapons) require: \`mc goto_near TABLE 2 && mc interact TABLE_X TABLE_Y TABLE_Z && mc craft ITEM\`.
- After crafting, wait a beat before equipping: \`mc craft wooden_axe\` then separately \`mc equip wooden_axe\`.

## Priorities
- Respond to player messages/commands first.
- Safety: eat when food < 14, flee or fight hostiles.
- Goal engine: follow \`mc goals\` urgency ranking. Typical: survive > food > wood > stone > tools.
- Never wait idle (no \`mc wait\` >10s). Night is for crafting, smelting, organizing chests, or indoor mining.

## Navigation
- Use \`mc marks\` / \`mc go_mark NAME\` for known places. Mark new useful spots.
- Use \`mc discover CATEGORY\` to find resources, not blind wandering.
- If \`mc collect\` fails, check the error, fix the tool/position, retry once, then move on.

## Communication
- One short chat line per trip (what you're doing / what you found).
- Ask the player if blocked twice on the same task.

Start by running \`mc status\`."
fi

# Env-var overrides for non-default modes (e.g. steward-driven sessions).
# HERMESCRAFT_PROMPT overrides the round-1 boot prompt; HERMESCRAFT_CONTINUE_PROMPT
# overrides the subsequent rounds. Both default to the goal-loop language above.
[ -n "${HERMESCRAFT_PROMPT:-}" ] && PROMPT="$HERMESCRAFT_PROMPT"

CONTINUE_PROMPT_FULL="${HERMESCRAFT_CONTINUE_PROMPT:-Continue the Minecraft session. Follow the OBSERVE→PLAN→ACT loop:
1. Run \`mc status\`, \`mc read_chat\`, \`mc commands\`, \`mc goals\`.
2. Pick the top-urgency goal. State your one-line plan.
3. Execute 3-8 commands, then re-check goals/status.
Do not idle or wait. Act on player requests immediately. Make measurable progress every round.}"

CONTINUE_PROMPT_MINIMAL="${HERMESCRAFT_CONTINUE_PROMPT_MINIMAL:-Continue. Run: mc status, mc read_chat, mc commands, mc goals.
Pick the top-urgency goal or player request, execute one focused subtask (3-8 mc commands), report one short progress line.
Only use mc commands. If blocked twice, switch goals.}"

ROUND=0
FINAL_EC=0
while true; do
    ROUND=$((ROUND + 1))

    # Pick continue prompt: minimal by default, full on round 1 and every Nth refresh.
    CONTINUE_PROMPT="$CONTINUE_PROMPT_FULL"
    if [ "$ROUND" -gt 1 ] && [ "$(printf '%s' "$CONTEXT_MINIMAL_CONTINUE" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
        if [ "$CONTEXT_REFRESH_EVERY_ROUNDS" -gt 0 ] && [ $((ROUND % CONTEXT_REFRESH_EVERY_ROUNDS)) -ne 0 ]; then
            CONTINUE_PROMPT="$CONTINUE_PROMPT_MINIMAL"
        fi
    fi

    set +e
    set +o pipefail
    if [ "$ROUND" -eq 1 ]; then
        MC_DEBUG_LOG="$MC_DEBUG_LOG" "$HERMES" chat --yolo --max-turns "$HERMES_MAX_TURNS" -m "$MODEL" --provider "$PROVIDER" \
            -t terminal,memory,skills -s minecraft-goals,minecraft-navigation,minecraft-chores \
            -q "$PROMPT" 2>&1 | tee -a "$AGENT_LOG"
    else
        # #90: prefer exact session-ID match. Only fall back to the
        # friendly name if we somehow lost the ID (first round of a
        # restarted-mid-loop script).
        CONTINUE_TARGET="${SESSION_ID:-$SESSION_NAME}"
        MC_DEBUG_LOG="$MC_DEBUG_LOG" "$HERMES" chat --yolo --max-turns "$HERMES_MAX_TURNS" -m "$MODEL" --provider "$PROVIDER" \
            -t terminal,memory,skills -s minecraft-goals,minecraft-navigation,minecraft-chores \
            --continue "$CONTINUE_TARGET" \
            -q "$CONTINUE_PROMPT" 2>&1 | tee -a "$AGENT_LOG"
    fi
    FINAL_EC=${PIPESTATUS[0]}
    set -o pipefail
    set -e

    if [ "$ROUND" -eq 1 ]; then
        SID=$(grep -oE 'Session:[[:space:]]+[0-9]{8}_[0-9]{6}_[a-f0-9]+' "$AGENT_LOG" 2>/dev/null | tail -1 | awk '{print $2}')
        if [ -n "${SID:-}" ]; then
            SESSION_ID="$SID"
            printf '%s\n' "$SID" > "$SESSION_ID_FILE"
            "$HERMES" sessions rename "$SID" "$SESSION_NAME" 2>/dev/null || true
        fi
    fi

    if [ "$AUTO_RESUME" != "true" ]; then
        trap - EXIT INT TERM
        cleanup
        exit "$FINAL_EC"
    fi

    echo ""
    echo "  [$(date '+%Y-%m-%d %H:%M:%S')] Hermes round $ROUND finished (exit $FINAL_EC). Resuming in ${RESTART_SLEEP_S}s — Ctrl+C to stop."
    sleep "$RESTART_SLEEP_S"
done
