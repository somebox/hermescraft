#!/usr/bin/env bash
# landfolk-control.sh — internal Landfolk engine (per-bot lifecycle:
# bot + watchdog + optional Hermes agent). The supported public CLI is
# `scripts/landfolk` — use that for day-to-day session management.
# This script is kept callable for advanced/debug workflows.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Load local secrets (.env is gitignored)
[[ -f "$SCRIPT_DIR/.env" ]] && set -a && source "$SCRIPT_DIR/.env" && set +a
BOT_DIR="$SCRIPT_DIR/bot"
BIN_DIR="$SCRIPT_DIR/bin"
PROMPT_DIR="$SCRIPT_DIR/prompts/landfolk"
SOUL_FILE="$SCRIPT_DIR/SOUL-landfolk.md"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
BASE_API_PORT="${BASE_API_PORT:-3001}"
PAPERMCP_PORT="${PAPERMCP_PORT:-25577}"
PAPERMCP_TOKEN="${PAPERMCP_TOKEN:-}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
STATE_DIR="$LOG_DIR/landfolk-control"
MODE="miner"
CONNECT_TIMEOUT_S="${CONNECT_TIMEOUT_S:-90}"
BOT_START_STAGGER_S="${BOT_START_STAGGER_S:-5}"
WATCHDOG_ENABLED="${WATCHDOG_ENABLED:-true}"
WATCHDOG_INTERVAL_S="${WATCHDOG_INTERVAL_S:-8}"
WATCHDOG_STUCK_ELAPSED_S="${WATCHDOG_STUCK_ELAPSED_S:-30}"
WATCHDOG_MAX_STUCK_EVENTS="${WATCHDOG_MAX_STUCK_EVENTS:-2}"
WATCHDOG_COLLECT_ELAPSED_S="${WATCHDOG_COLLECT_ELAPSED_S:-45}"
WATCHDOG_CONNECT_COOLDOWN_SEC="${WATCHDOG_CONNECT_COOLDOWN_SEC:-45}"
AGENT_ROUND_TIMEOUT_S="${AGENT_ROUND_TIMEOUT_S:-90}"
DANGER_AUTOREACT_ENABLED="${DANGER_AUTOREACT_ENABLED:-true}"
DANGER_AUTOREACT_NIGHT_ONLY="${DANGER_AUTOREACT_NIGHT_ONLY:-true}"
DANGER_SCAN_RADIUS="${DANGER_SCAN_RADIUS:-32}"
DANGER_HELP_RADIUS="${DANGER_HELP_RADIUS:-24}"
DANGER_CHAT_COOLDOWN_SEC="${DANGER_CHAT_COOLDOWN_SEC:-25}"
DANGER_ACTION_COOLDOWN_SEC="${DANGER_ACTION_COOLDOWN_SEC:-15}"
DANGER_FLEE_HEALTH="${DANGER_FLEE_HEALTH:-8}"
DANGER_RETREAT_HEALTH="${DANGER_RETREAT_HEALTH:-7}"
DANGER_FIGHT_DURATION_S="${DANGER_FIGHT_DURATION_S:-18}"
DANGER_BASE_MARK="${DANGER_BASE_MARK:-base}"
CONTEXT_MINIMAL_CONTINUE="${CONTEXT_MINIMAL_CONTINUE:-true}"
CONTEXT_REFRESH_EVERY_ROUNDS="${CONTEXT_REFRESH_EVERY_ROUNDS:-12}"
MC_DEBUG_ENABLED="${MC_DEBUG_ENABLED:-true}"
PROFILES_CSV=""
STOP_OTHERS=true
ALL_PROFILES=false
FORCE=false
# When true, `start` brings up bot + watchdog only (no continuous Hermes
# agent). Used by `scripts/landfolk` kanban mode so gateway workers own
# the bot port without fighting an always-on agent loop.
NO_AGENT=false

# LLM routing + roster: edit data/agent-models.json (``agents`` keys = controllable profiles).
# API TCP port: per-agent ``api_port`` in AGENT_MODELS.json, else BASE_API_PORT + index (see resolve-agent-model.py api-port).
AGENT_MODELS_JSON="${AGENT_MODELS_JSON:-$SCRIPT_DIR/data/agent-models.json}"
RESOLVE_AGENT_MODEL_PY="$SCRIPT_DIR/scripts/resolve-agent-model.py"

load_all_agent_names() {
  local out
  if ! out="$(python3 "$RESOLVE_AGENT_MODEL_PY" agent-names "$AGENT_MODELS_JSON" 2>/dev/null)"; then
    echo "Failed to read agent roster from ${AGENT_MODELS_JSON} (run: python3 ${RESOLVE_AGENT_MODEL_PY} agent-names)." >&2
    exit 1
  fi
  if [ -z "$out" ]; then
    echo "No agents defined in ${AGENT_MODELS_JSON} (add at least one entry under \"agents\")." >&2
    exit 1
  fi
  ALL_AGENT_NAMES=()
  while IFS= read -r line; do
    [ -n "$line" ] && ALL_AGENT_NAMES+=("$line")
  done <<< "$out"
}

load_all_agent_names

contains_name() {
  local needle="$1"
  shift
  for n in "$@"; do
    if [ "$n" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

usage() {
  cat <<EOF
Usage:
  ./scripts/landfolk-control.sh start [--profiles p1,p2,...] [--mode miner|duo|all]
  ./scripts/landfolk-control.sh stop [--profiles p1,p2,...] [--mode miner|duo|all] [--all-profiles] [--force]
  ./scripts/landfolk-control.sh status [--profiles p1,p2,...] [--mode miner|duo|all] [--all-profiles]
  ./scripts/landfolk-control.sh enable [--profiles p1,p2,...]
  ./scripts/landfolk-control.sh disable [--profiles p1,p2,...]
  ./scripts/landfolk-control.sh profiles list   # canonical names + resolved model/provider

TUI log viewer (colors + /health):  ./bin/landfolk-log-view   (LOG_DIR and BASE_API_PORT respected)

Environment:
  MC_HOST, MC_PORT, BASE_API_PORT (overrides landfolk.base_api_port in AGENT_MODELS_JSON for default port math)
  AGENT_MODELS_JSON — models, optional per-agent api_port, optional landfolk.base_api_port (default: repo data/agent-models.json)
  HERMES_MODEL or MODEL — resolver fallback only if agents.<Profile> lacks model (same as start-gatherer.sh without a positional MODEL)
  HERMES_PROVIDER or PROVIDER — resolver fallback similarly
  MODEL_<PROFILE>, PROVIDER_<PROFILE> — per-profile overrides (suffix from agent name, e.g.
    MODEL_GATHERER, MODEL_FLINT, MODEL_BARLEY, MODEL_MASON)
  LOG_DIR
  WATCHDOG_ENABLED=true|false
  WATCHDOG_INTERVAL_S (default 8)
  WATCHDOG_STUCK_ELAPSED_S (default 30) — cancel long-running movement/dig tasks (goto, tunnel, stair_down, …)
  WATCHDOG_MAX_STUCK_EVENTS (default 2)
  WATCHDOG_COLLECT_ELAPSED_S (default 45)
  WATCHDOG_CONNECT_COOLDOWN_SEC (default 45) — min seconds between watchdog POST /connect retries when disconnected
  AGENT_ROUND_TIMEOUT_S (default 120) — kill stalled Hermes round and continue next loop
  DANGER_AUTOREACT_ENABLED=true|false (default true) — watchdog auto danger response
  DANGER_AUTOREACT_NIGHT_ONLY=true|false (default true) — react only at night unless distress chat
  DANGER_SCAN_RADIUS (default 32), DANGER_HELP_RADIUS (default 24)
  DANGER_CHAT_COOLDOWN_SEC (default 25), DANGER_ACTION_COOLDOWN_SEC (default 15)
  DANGER_FLEE_HEALTH (default 8), DANGER_RETREAT_HEALTH (default 7), DANGER_FIGHT_DURATION_S (default 18)
  DANGER_BASE_MARK (default base) — flee destination mark when low HP
  CONNECT_TIMEOUT_S (default 90) — landfolk wait_for_bot_connected poll window
  BOT_START_STAGGER_S (default 5) — sleep after each bot start before checking health (multi-bot MC join)
  MC_CONNECT_TIMEOUT_MS (bot process) — Mineflayer login TCP timeout, default 55000 (set on node env in start_bot)
  CONTEXT_MINIMAL_CONTINUE=true|false
  CONTEXT_REFRESH_EVERY_ROUNDS (default 12)
  MC_DEBUG_ENABLED=true|false

Model routing matches single-profile launches: scripts/resolve-agent-model.py
( MODEL_<PROFILE> → agents.<Profile> in AGENT_MODELS_JSON → defaults → HERMES_MODEL/MODEL ).
Each agent Hermes loop re-resolves so JSON edits apply on the next round (bots still serve
/health model from bot startup until node process restarts; command center polls live observe).

Hermes child processes clear inherited MODEL, HERMES_MODEL, PROVIDER, HERMES_PROVIDER so routing
cannot be overridden silently by shell exports; Hermes sees only resolver output via -m / --provider.

Modes:
  miner  Flint if listed in AGENT_MODELS_JSON, else first agent in that file
  duo    Gatherer then Flint when both are listed
  all    every agent key in AGENT_MODELS_JSON (JSON key order)

Examples:
  ./scripts/landfolk-control.sh start --profiles flint,gatherer,mason
  ./scripts/landfolk-control.sh stop --profiles flint
  ./scripts/landfolk-control.sh status --profiles gatherer,flint
  ./scripts/landfolk-control.sh enable --profiles flint
  ./scripts/landfolk-control.sh disable --profiles gatherer
  ./scripts/landfolk-control.sh stop --all-profiles --force
  ./scripts/landfolk-control.sh start --profiles flint --no-agent   # bot + watchdog only (kanban mode)

Profile names: lowercase keys from \"agents\" in AGENT_MODELS_JSON (e.g. barley, flint, mason, gatherer).
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

if [[ "$1" = "--help" || "$1" = "-h" ]]; then
  usage
  exit 0
fi

COMMAND="$1"
shift
SUBCOMMAND=""

if [ "$COMMAND" = "profiles" ]; then
  SUBCOMMAND="${1:-}"
  shift || true
fi

if [ "$COMMAND" = "enable" ]; then
  COMMAND="start"
  STOP_OTHERS=false
fi

if [ "$COMMAND" = "disable" ]; then
  COMMAND="stop"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --profiles)
      PROFILES_CSV="$2"
      shift 2
      ;;
    --no-stop-others)
      STOP_OTHERS=false
      shift
      ;;
    --all-profiles)
      ALL_PROFILES=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --no-agent)
      NO_AGENT=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

normalize_profile_name() {
  local raw="$1"
  local key ak a
  key="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | xargs)"
  for a in "${ALL_AGENT_NAMES[@]}"; do
    ak="$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')"
    if [ "$ak" = "$key" ]; then
      printf '%s\n' "$a"
      return 0
    fi
  done
  printf ''
}

agents_from_mode() {
  case "$MODE" in
    miner)
      if contains_name "Flint" "${ALL_AGENT_NAMES[@]}"; then
        printf '%s\n' "Flint"
      else
        printf '%s\n' "${ALL_AGENT_NAMES[0]}"
      fi
      ;;
    duo)
      if contains_name "Gatherer" "${ALL_AGENT_NAMES[@]}"; then
        printf '%s\n' "Gatherer"
      fi
      if contains_name "Flint" "${ALL_AGENT_NAMES[@]}"; then
        printf '%s\n' "Flint"
      fi
      ;;
    all)
      printf '%s\n' "${ALL_AGENT_NAMES[@]}"
      ;;
    *)
      echo ""
      ;;
  esac
}

agents_from_profiles_csv() {
  local raw="$1"
  local out=()
  IFS=',' read -r -a parts <<< "$raw"
  for p in "${parts[@]}"; do
    local norm
    norm="$(normalize_profile_name "$p")"
    if [ -z "$norm" ]; then
      return 1
    fi
    local seen=false
    for cur in "${out[@]}"; do
      if [ "$cur" = "$norm" ]; then
        seen=true
        break
      fi
    done
    if [ "$seen" = false ]; then
      out+=("$norm")
    fi
  done
  printf '%s\n' "${out[@]}"
}

model_for_name() {
  local name="$1"
  python3 "$RESOLVE_AGENT_MODEL_PY" "$name" model "$AGENT_MODELS_JSON"
}

provider_for_name() {
  local name="$1"
  python3 "$RESOLVE_AGENT_MODEL_PY" "$name" provider "$AGENT_MODELS_JSON"
}

port_for_name() {
  local name="$1"
  BASE_API_PORT="${BASE_API_PORT:-3001}" python3 "$RESOLVE_AGENT_MODEL_PY" api-port "$name" "$AGENT_MODELS_JSON" 2>/dev/null || echo ""
}

if [ "$COMMAND" = "profiles" ]; then
  if [ "$SUBCOMMAND" = "list" ]; then
    echo "Profiles — resolved model/provider (config: ${AGENT_MODELS_JSON})"
    printf '%-12s  %-48s %-10s %s\n' "profile" "model" "api" "provider"
    for profile in "${ALL_AGENT_NAMES[@]}"; do
      m="$(model_for_name "$profile")"
      p="$(provider_for_name "$profile")"
      key="$(printf '%s' "$profile" | tr '[:upper:]' '[:lower:]')"
      port="$(port_for_name "$profile")"
      printf '%-12s  %-48s %-10s %s\n' "$key" "$m" ":$port" "$p"
    done
    exit 0
  fi
  echo "Usage: ./scripts/landfolk-control.sh profiles list"
  exit 1
fi

running_agents() {
  local found=()
  for name in "${ALL_AGENT_NAMES[@]}"; do
    for kind in bot agent watchdog; do
      local pf="$STATE_DIR/${kind}-${name,,}.pid"
      if [ -f "$pf" ]; then
        local pid
        pid="$(cat "$pf" 2>/dev/null)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
          found+=("$name")
          break
        fi
      fi
    done
  done
  printf '%s\n' "${found[@]}"
}

if [ "$ALL_PROFILES" = true ]; then
  AGENTS=("${ALL_AGENT_NAMES[@]}")
elif [ -n "$PROFILES_CSV" ]; then
  set +e
  profiles_output="$(agents_from_profiles_csv "$PROFILES_CSV")"
  parse_ec=$?
  set -e
  AGENTS=()
  while IFS= read -r line; do
    [ -n "$line" ] && AGENTS+=("$line")
  done <<< "$profiles_output"
  if [ "$parse_ec" -ne 0 ] || [ "${#AGENTS[@]}" -eq 0 ]; then
    echo "Invalid --profiles value: $PROFILES_CSV"
    echo "Run: ./scripts/landfolk-control.sh profiles list"
    exit 1
  fi
elif [ "$COMMAND" = "status" ]; then
  # status without --profiles: show all known agents
  AGENTS=("${ALL_AGENT_NAMES[@]}")
elif [ "$COMMAND" = "stop" ]; then
  # stop without --profiles: target all running agents
  AGENTS=()
  while IFS= read -r line; do
    [ -n "$line" ] && AGENTS+=("$line")
  done < <(running_agents)
  if [ "${#AGENTS[@]}" -eq 0 ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && AGENTS+=("$line")
    done < <(agents_from_mode)
  fi
else
  AGENTS=()
  while IFS= read -r line; do
    [ -n "$line" ] && AGENTS+=("$line")
  done < <(agents_from_mode)
  if [ "${#AGENTS[@]}" -eq 0 ]; then
    echo "Invalid mode: $MODE (expected miner|duo|all)"
    exit 1
  fi
fi

force_stop_profile() {
  local name="$1"
  local name_lower="${name,,}"

  # Kill any process that still has profile logs open (often unmanaged hermes chat loops).
  local pids=""
  pids="$(lsof -t "$LOG_DIR/agent-${name_lower}.log" "$LOG_DIR/agent-${name_lower}-stderr.log" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    for pid in $pids; do
      local comm
      comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
      case "$comm" in
        *Python*|*python*)
          kill "$pid" 2>/dev/null || true
          ;;
      esac
    done
    sleep 1
    pids="$(lsof -t "$LOG_DIR/agent-${name_lower}.log" "$LOG_DIR/agent-${name_lower}-stderr.log" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      for pid in $pids; do
        local comm
        comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
        case "$comm" in
          *Python*|*python*)
            kill -9 "$pid" 2>/dev/null || true
            ;;
        esac
      done
    fi
    echo "[force] cleaned lingering agent log writers for $name"
  fi

  local port
  port="$(port_for_name "$name")"
  if [ -n "$port" ]; then
    kill_listener_on_port "$port"
  fi
}

pid_file() {
  local type="$1"
  local name="$2"
  local name_lower="${name,,}"
  echo "$STATE_DIR/${type}-${name_lower}.pid"
}

pid_file_candidates() {
  local type="$1"
  local name="$2"
  local name_lower="${name,,}"
  local canonical
  canonical="$(pid_file "$type" "$name")"
  printf '%s\n' "$canonical"
  local f
  for f in "$STATE_DIR"/*-"$type"-"$name_lower".pid; do
    [ -e "$f" ] || continue
    [ "$f" = "$canonical" ] && continue
    printf '%s\n' "$f"
  done
}

cleanup_legacy_pid_files() {
  local type="$1"
  local name="$2"
  local canonical
  canonical="$(pid_file "$type" "$name")"
  while IFS= read -r pf; do
    [ -z "$pf" ] && continue
    [ "$pf" = "$canonical" ] && continue
    rm -f "$pf"
  done < <(pid_file_candidates "$type" "$name")
}

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

kill_listener_on_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti TCP:"$port" 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  pids="$(lsof -ti TCP:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

ensure_hermes() {
  local hermes_cmd=""
  for c in hermes "$HOME/.local/bin/hermes" /usr/local/bin/hermes; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then
      hermes_cmd="$c"
      break
    fi
  done
  if [ -z "$hermes_cmd" ]; then
    echo "hermes CLI not found"
    exit 1
  fi
}

prompt_file_for_name() {
  local name="$1"
  case "$name" in
    Gatherer)
      echo "$PROMPT_DIR/gatherer-test.md"
      ;;
    *)
      echo "$PROMPT_DIR/${name,,}.md"
      ;;
  esac
}

start_bot() {
  local name="$1"
  local port="$2"
  local bot_agent_model
  local bot_agent_provider
  local pidf
  local viewer_port=$((port + 1000))
  pidf="$(pid_file bot "$name")"
  local name_lower="${name,,}"
  bot_agent_model="$(model_for_name "$name")"
  bot_agent_provider="$(provider_for_name "$name")"

  # Ensure this API port is exclusively owned by this launch.
  kill_listener_on_port "$port"

  if [ -f "$pidf" ] && is_pid_alive "$(cat "$pidf")"; then
    echo "[bot] $name already running (pid $(cat "$pidf"))"
    return 0
  fi

  if curl -sf "http://localhost:${port}/health" >/dev/null 2>&1; then
    echo "[bot] $name already responding on :$port"
    return 0
  fi

  (
    cd "$BOT_DIR"
    trap '' HUP
    _bot_stop=false
    trap '_bot_stop=true; kill %1 2>/dev/null' TERM INT
    while [ "$_bot_stop" = false ]; do
      FAIR_PLAY="${FAIR_PLAY:-true}" \
        MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$name" API_PORT="$port" \
        MC_CONNECT_TIMEOUT_MS="${MC_CONNECT_TIMEOUT_MS:-55000}" \
        PAPERMCP_HOST="$MC_HOST" PAPERMCP_PORT="$PAPERMCP_PORT" PAPERMCP_TOKEN="$PAPERMCP_TOKEN" \
        AGENT_PROFILE="$name" AGENT_MODEL="$bot_agent_model" AGENT_PROVIDER="$bot_agent_provider" \
        VIEWER_PORT="$viewer_port" \
        BOT_MOVEMENT_PROFILE="${BOT_MOVEMENT_PROFILE:-}" \
        node server.js >> "$LOG_DIR/bot-${name_lower}.log" 2>&1
      if [ "$_bot_stop" = true ]; then break; fi
      echo "[$(date '+%H:%M:%S')] bot $name exited, restarting in 5s..." >> "$LOG_DIR/bot-${name_lower}.log"
      sleep 5
    done
  ) &
  local pid="$!"
  echo "$pid" > "$pidf"
  cleanup_legacy_pid_files bot "$name"
  echo "[bot] started $name on :$port (pid $pid)"
  echo "[bot] $name → AGENT_MODEL=$bot_agent_model  AGENT_PROVIDER=$bot_agent_provider  (see bot-${name_lower}.log on listen)"
}

start_watchdog() {
  local name="$1"
  local port="$2"
  local enabled
  enabled="$(printf '%s' "${WATCHDOG_ENABLED:-true}" | tr '[:upper:]' '[:lower:]')"
  if [ "$enabled" = "false" ] || [ "$enabled" = "0" ] || [ "$enabled" = "no" ]; then
    return 0
  fi

  local pidf
  pidf="$(pid_file watchdog "$name")"
  local name_lower="${name,,}"
  local wd_log="$LOG_DIR/watchdog-${name_lower}.log"

  if [ -f "$pidf" ] && is_pid_alive "$(cat "$pidf")"; then
    echo "[watchdog] $name already running (pid $(cat "$pidf"))"
    return 0
  fi

  (
    stuck_hits=0
    last_danger_chat_wall=0
    last_danger_action_wall=0
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[$ts] watchdog active interval=${WATCHDOG_INTERVAL_S}s stuck_elapsed=${WATCHDOG_STUCK_ELAPSED_S}s collect_elapsed=${WATCHDOG_COLLECT_ELAPSED_S}s connect_cooldown=${WATCHDOG_CONNECT_COOLDOWN_SEC}s max_hits=${WATCHDOG_MAX_STUCK_EVENTS}" >> "$wd_log"
    last_connect_wall=0
    while true; do
      ts="$(date '+%Y-%m-%d %H:%M:%S')"
      now_wall="$(date +%s)"
      health_json="$(curl -sf "http://localhost:${port}/health" 2>/dev/null || true)"
      connected="false"
      if [ -z "$health_json" ]; then
        echo "[$ts] watchdog: no HTTP response from http://localhost:${port}/health (listener down or refused)" >> "$wd_log"
      else
        connected="$(printf '%s' "$health_json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(bool(d.get('connected'))).lower())" 2>/dev/null || echo "false")"
      fi

      if [ "$connected" != "true" ]; then
        if [ "$((now_wall - last_connect_wall))" -ge "${WATCHDOG_CONNECT_COOLDOWN_SEC:-45}" ]; then
          # F-NEW: force-reconnect to break Mineflayer 4.37+ "session replacement
          # already in flight" deadlocks. Plain POST /connect no-ops if Mineflayer
          # thinks a reconnect is in progress; force=true breaks that latch.
          # Cost: a forced reconnect drops/redials the socket, ~1s blip. Worth it
          # — without force=true the bot can sit "disconnected" indefinitely.
          curl -sf -X POST "http://localhost:${port}/connect" \
            -H "Content-Type: application/json" \
            -d '{"force":true}' >/dev/null 2>&1 || true
          last_connect_wall="$now_wall"
          echo "[$ts] watchdog POST /connect (force=true; disconnected or health probe failed)" >> "$wd_log"
        fi
        sleep "$WATCHDOG_INTERVAL_S"
        continue
      fi

      # F-NEW: WATCHDOG_CONNECT_ONLY mode — run ONLY the connect-keepalive
      # loop above; skip stuck-task recovery + danger reactor. Useful when
      # the bot is driven by a kanban-worker (or any external orchestrator)
      # that does its own task management; the watchdog would otherwise
      # cancel the worker's in-flight tasks. Set in env when starting bots
      # for kanban-mode: WATCHDOG_CONNECT_ONLY=1 ./scripts/landfolk-control.sh start --profiles flint
      if [ "${WATCHDOG_CONNECT_ONLY:-}" = "1" ] || [ "${WATCHDOG_CONNECT_ONLY:-}" = "true" ]; then
        sleep "$WATCHDOG_INTERVAL_S"
        continue
      fi

      task_json="$(curl -sf "http://localhost:${port}/task" 2>/dev/null || echo '{}')"
      task_fields="$(printf '%s' "$task_json" | python3 -c "import sys,json; d=json.load(sys.stdin); t=(d.get('data') or {}).get('task') or d.get('task') or {}; print(f\"{t.get('status','')}|{t.get('action','')}|{t.get('elapsed_s',0)}|{(t.get('error') or '').replace('|','/')}\")" 2>/dev/null || echo '|||')"
      IFS='|' read -r task_status task_action task_elapsed task_error <<< "$task_fields"
      task_elapsed="${task_elapsed:-0}"

      should_recover=false
      recover_reason=""
      if [ "$task_status" = "stuck" ]; then
        should_recover=true
        recover_reason="task status stuck"
      elif [ "$task_status" = "running" ] && [ "$task_action" = "collect" ] && [ "${task_elapsed%.*}" -ge "$WATCHDOG_COLLECT_ELAPSED_S" ]; then
        should_recover=true
        recover_reason="collect running ${task_elapsed}s"
      elif [ "$task_status" = "running" ]; then
        # Same idea as bot STUCK_MOVEMENT_ACTIONS — tunnel/stair_down used to hang with no goto-specific recover.
        case "$task_action" in
          goto|go_mark|goto_near|follow|deathpoint|pickup|tunnel|stair_down|dig_area|pillar_step|combo|strafe|flee|fight)
            if [ "${task_elapsed%.*}" -ge "$WATCHDOG_STUCK_ELAPSED_S" ]; then
              should_recover=true
              recover_reason="${task_action} running ${task_elapsed}s"
            fi
            ;;
        esac
      fi

      if [ "$should_recover" = true ]; then
        stuck_hits=$((stuck_hits + 1))
        echo "[$ts] recover=$recover_reason hits=$stuck_hits error=${task_error:-none}" >> "$wd_log"
        curl -sf -X POST "http://localhost:${port}/task/cancel" -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1 || true
        sleep 1
        if [ "$stuck_hits" -ge "$WATCHDOG_MAX_STUCK_EVENTS" ]; then
          # Regroup: walk to a known mark from the bot's locations file.
          # Pull the live mark catalog once, then call go_mark on the first
          # present candidate. Order: `home` (auto-set on first spawn /
          # set_home), `mine_entrance` (base1 epic site), `base` (canonical
          # production anchor). If none exist the bot stays put — next tick
          # falls through to mc escape.
          marks_json="$(curl -sf "http://localhost:${port}/marks" 2>/dev/null || echo '{}')"
          regroup_target="$(printf '%s' "$marks_json" | python3 -c "
import json, sys
try: d = json.load(sys.stdin)
except Exception: d = {}
have = {m.get('name') for m in (d.get('data') or {}).get('marks') or [] if m.get('name')}
for cand in ('home', 'mine_entrance', 'base'):
    if cand in have:
        print(cand); break
" 2>/dev/null)"
          if [ -n "$regroup_target" ]; then
            curl -sf -X POST "http://localhost:${port}/action/go_mark" \
              -H "Content-Type: application/json" \
              -d "{\"name\":\"${regroup_target}\"}" >/dev/null 2>&1 || true
            echo "[$ts] watchdog regroup -> ${regroup_target}" >> "$wd_log"
          else
            echo "[$ts] watchdog regroup skipped (no canonical mark present)" >> "$wd_log"
          fi
          stuck_hits=0
        fi
      else
        if [ "$task_status" = "running" ] || [ "$task_status" = "done" ] || [ "$task_status" = "idle" ] || [ "$task_status" = "cancelled" ] || [ "$task_status" = "error" ] || [ -z "$task_status" ]; then
          stuck_hits=0
        fi
      fi

      danger_enabled="$(printf '%s' "${DANGER_AUTOREACT_ENABLED:-true}" | tr '[:upper:]' '[:lower:]')"
      if [ "$danger_enabled" = "true" ] || [ "$danger_enabled" = "1" ] || [ "$danger_enabled" = "yes" ]; then
        observe_json="$(curl -sf "http://localhost:${port}/observe" 2>/dev/null || echo '{}')"
        danger_fields="$(printf '%s\n' "$observe_json" | python3 -c "
import json,sys
try: obs=json.loads(sys.stdin.readline() or '{}')
except Exception: obs={}
state=obs.get('state') or {}
try: health=float(state.get('health', 20))
except Exception: health=20.0
dmg=state.get('damage_telemetry') or {}
try: dmg_ago=float(dmg.get('seconds_ago', 999))
except Exception: dmg_ago=999.0
try: last_dmg=float(dmg.get('last_damage', 0))
except Exception: last_dmg=0.0
is_day=obs.get('is_day')
if is_day is None:
  is_day=(obs.get('state') or {}).get('isDay', True)
under_attack = dmg_ago < 12 and last_dmg > 0
low_hp = health < 10
print(f'{1 if bool(is_day) else 0}|{int(round(health))}|{1 if under_attack else 0}|{1 if low_hp else 0}')
" 2>/dev/null || echo "1|20|0|0")"
        IFS='|' read -r danger_is_day danger_health danger_under_attack danger_low_hp <<< "$danger_fields"

        should_react=false
        react_reason=""
        if [ "${danger_under_attack:-0}" -eq 1 ]; then
          should_react=true
          react_reason="taking-damage"
        elif [ "${danger_low_hp:-0}" -eq 1 ]; then
          should_react=true
          react_reason="low-hp"
        fi

        if [ "$should_react" = true ]; then
          if [ "$((now_wall - last_danger_chat_wall))" -ge "${DANGER_CHAT_COOLDOWN_SEC:-25}" ]; then
            alert_msg="ALERT ${name}: ${react_reason} hp=${danger_health}"
            alert_body="$(python3 -c "import json,sys; print(json.dumps({'message':sys.argv[1]}))" "$alert_msg" 2>/dev/null || echo '{"message":"ALERT: under attack"}')"
            curl -sf -X POST "http://localhost:${port}/action/chat" -H "Content-Type: application/json" -d "$alert_body" >/dev/null 2>&1 || true
            last_danger_chat_wall="$now_wall"
          fi

          if [ "$((now_wall - last_danger_action_wall))" -ge "${DANGER_ACTION_COOLDOWN_SEC:-15}" ]; then
            curl -sf -X POST "http://localhost:${port}/task/cancel" -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1 || true
            if [ "${danger_health:-20}" -le "${DANGER_FLEE_HEALTH:-8}" ]; then
              curl -sf -X POST "http://localhost:${port}/action/flee" -H "Content-Type: application/json" -d '{"distance":16}' >/dev/null 2>&1 || true
              echo "[$ts] danger-react: flee health=${danger_health} reason=${react_reason}" >> "$wd_log"
            else
              curl -sf -X POST "http://localhost:${port}/action/fight" -H "Content-Type: application/json" -d '{"target":"","retreat_health":7,"duration":18}' >/dev/null 2>&1 || true
              echo "[$ts] danger-react: fight health=${danger_health} reason=${react_reason}" >> "$wd_log"
            fi
            last_danger_action_wall="$now_wall"
          fi
        fi
      fi

      sleep "$WATCHDOG_INTERVAL_S"
    done
  ) &
  local pid="$!"
  echo "$pid" > "$pidf"
  cleanup_legacy_pid_files watchdog "$name"
  echo "[watchdog] started $name on :$port (pid $pid)"
}

wait_for_bot_connected() {
  local name="$1"
  local port="$2"
  local waited=0
  local posted_connect=false

  while [ "$waited" -lt "$CONNECT_TIMEOUT_S" ]; do
    local connected
    connected="$(curl -sf "http://localhost:${port}/health" 2>/dev/null | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('connected', False)).lower())" 2>/dev/null || echo "false")"
    if [ "$connected" = "true" ]; then
      echo "[bot] $name connected on :$port"
      return 0
    fi

    # Exactly one POST /connect after the listener responds but MC is still handshaking.
    # Repeating /connect during mineflayer login used to quit() mid-handshake (looked like random disconnects).
    if [ "$posted_connect" = false ] && curl -sf "http://localhost:${port}/health" >/dev/null 2>&1; then
      posted_connect=true
      curl -sf -X POST "http://localhost:${port}/connect" >/dev/null 2>&1 || true
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "[bot] $name failed to connect within ${CONNECT_TIMEOUT_S}s on :$port"
  return 1
}

start_agent() {
  local name="$1"
  local port="$2"
  local pidf
  pidf="$(pid_file agent "$name")"
  local name_lower="${name,,}"

  if [ -f "$pidf" ] && is_pid_alive "$(cat "$pidf")"; then
    echo "[agent] $name already running (pid $(cat "$pidf"))"
    return 0
  fi

  local agent_home="$HOME/.hermes-landfolk-${name_lower}"
  local prompt_file
  local prompt
  local continue_prompt
  local continue_prompt_full
  local continue_prompt_minimal
  local continue_prompt_round
  local session_name="landfolk-${name_lower}"
  local session_ref_file="$STATE_DIR/session-${name_lower}.txt"
  local agent_model
  # Pin the agent's kanban context to the SHARED default home, not the
  # per-profile $agent_home. Without this, `hermes kanban` invoked from
  # the continuous loop resolves the DB via HERMES_HOME → finds an empty
  # per-profile DB (`$agent_home/kanban/boards/...`) instead of the real
  # one (`~/.hermes/kanban/boards/...`) the dispatcher and kanban workers
  # use. Symptom: Steward's continuous loop reported "board is empty"
  # while Flint/Mason were happily running cards. Matches the
  # dispatcher's env injection in _default_spawn (kanban_db.py).
  local kanban_board="${KANBAN_BOARD:-landfolk-ops}"
  local kanban_db_root="${HERMES_KANBAN_ROOT:-$HOME/.hermes/kanban}"
  local kanban_db="$kanban_db_root/boards/$kanban_board/kanban.db"
  local kanban_workspaces="$kanban_db_root/boards/$kanban_board/workspaces"
  local agent_provider
  local agent_log="$LOG_DIR/agent-${name_lower}.log"
  local agent_err_log="$LOG_DIR/agent-${name_lower}-stderr.log"
  local hermes_log="$LOG_DIR/hermes-${name_lower}.log"
  local progress_log="$LOG_DIR/progress-${name_lower}.log"
  local mc_debug_log="$LOG_DIR/mc-${name_lower}.log"
  local mc_debug_env=()
  local hermes_timeout_prefix=()
  local restricted_bin="$agent_home/restricted-bin"
  local hermes_runtime_path=""

  prompt_file="$(prompt_file_for_name "$name")"

  if [ ! -f "$prompt_file" ]; then
    echo "[agent] missing prompt file: $prompt_file"
    return 1
  fi

  mkdir -p "$agent_home/memories" "$agent_home/sessions" "$agent_home/skills/gaming"
  cp "$SOUL_FILE" "$agent_home/SOUL.md"
  if [ -f "$HOME/.hermes/config.yaml" ]; then
    cp "$HOME/.hermes/config.yaml" "$agent_home/config.yaml"
    for sedcmd in \
      's/max_iterations: [0-9]*/max_iterations: 500/' \
      's/memory_char_limit: [0-9]*/memory_char_limit: 4400/' \
      's/memory_enabled: false/memory_enabled: true/' \
      's/user_profile_enabled: false/user_profile_enabled: true/'; do
      sed -i '' "$sedcmd" "$agent_home/config.yaml" 2>/dev/null || sed -i "$sedcmd" "$agent_home/config.yaml" 2>/dev/null || true
    done
  fi
  for f in .env auth.json auth.lock; do
    [ -f "$HOME/.hermes/$f" ] && ln -sf "$HOME/.hermes/$f" "$agent_home/$f" 2>/dev/null || true
  done

  QUIET=1 "$SCRIPT_DIR/scripts/sync-skills.sh" "$agent_home/skills/gaming"

  shared_rules="## Hard rules
Only use mc commands. Never run curl, lsof, ps, netstat, kill, grep, ls, cd, or shell diagnostics.
Never run mc connect. Use mc help to list verbs when stuck.
Never break building blocks or take shared crafting tables/furnaces/chests.
Preserve infrastructure: stairs, hallways, torch lines, paths, chest/furnace areas.
Before each burst: mc status and mc read_chat.
One active task at a time: mc task before starting, mc cancel if stale.
Combat: mc attack, mc fight, mc flee, mc eat. Never invent commands like defend/combat_mode.
NEVER start bot bodies for yourself or other profiles. If your mc API at
\$MC_API_URL doesn't respond, kanban_block with reason \"bot_offline:<your-name>\"
and stop. Operators control which bots are online via landfolk-session.sh.
Forbidden launchers: start-gatherer-bot.sh, start-flint-bot.sh,
start-mason-bot.sh, landfolk-control.sh start, run-landfolk-agent.sh."
  runtime_rules=""
  build_policy=""
  # Role classification — drives starter + continue prompt shape. Orchestrators
  # (Steward) manage the kanban board and observe the fleet; workers chop wood
  # and place blocks. The two need fundamentally different per-cycle prompts:
  # the worker loop says "pick a goal, run mc commands", the orchestrator loop
  # says "read the board, decompose, rebalance".
  case "$name" in
    Steward) role="orchestrator" ;;
    *)       role="worker" ;;
  esac
  case "$name" in
    Flint)
      starter_cmds="mc goal_load miner, mc observe, mc goals, mc read_chat."
      ;;
    Mason)
      starter_cmds="mc goal_load builder, mc observe, mc goals, mc read_chat."
      ;;
    Gatherer)
      starter_cmds="mc goal_load gatherer, mc observe, mc goals, mc read_chat."
      ;;
    Barley)
      starter_cmds="mc observe, mc goals, mc read_chat."
      ;;
    Steward)
      # Orchestrator starter: kanban observation first, then in-world state
      # (read-only for situational awareness only — Steward never mines).
      starter_cmds="hermes kanban --board landfolk-ops stats, hermes kanban --board landfolk-ops list --status running, hermes kanban --board landfolk-ops list --status ready, hermes kanban --board landfolk-ops list --status blocked, scripts/roster.py, mc status, mc read_chat."
      ;;
    *)
      starter_cmds="mc observe, mc goals, mc read_chat."
      ;;
  esac
  prompt="$(cat "$prompt_file")

${shared_rules}

Start with: ${starter_cmds}"

  if [ "$role" = "orchestrator" ]; then
    # Steward's per-cycle prompt: kanban-first observation, then ONE
    # orchestration action (decompose / supervise / reassign / unblock /
    # archive / comment). Never \"pick a goal\" — Steward's goals are
    # board flow + fleet balance, not wood/stone gaps. The bot body is
    # read-only; if anything in-world needs changing, it becomes a card.
    continue_prompt_full="Continue (orchestrator cycle). Steward checks the board, then acts.

Each cycle:
1. hermes kanban --board landfolk-ops stats
2. hermes kanban --board landfolk-ops list --status running
3. hermes kanban --board landfolk-ops list --status ready
4. hermes kanban --board landfolk-ops list --status blocked
5. mc status (verify you're safe at base; no mining/building)
6. mc read_chat (look for @steward triggers from re44 + worker chatter)

Then take ONE of these actions, narrate it in chat:
  • Decompose triage / oversized cards with hermes kanban create — set explicit --assignee flint|mason|gatherer after scripts/roster.py --assignable
  • Unblock / comment on a blocked card
  • Reassign a card if the fleet is imbalanced (hermes kanban reassign <id> <profile> --reclaim)
  • Archive a stale / superseded card
  • Open a [BUG] card for re44 when blockage is a framework defect
  • If the board is healthy and fleet busy: write a memory note and wait.

NEVER touch mc dig / place / collect / craft / fill / smelt — orchestrator only. Bot body stays near base unless a planning task requires going somewhere to inspect (and then come back).
$shared_rules"
    continue_prompt_minimal="Continue (orchestrator). Read the board (hermes kanban stats + list running/ready/blocked), then take ONE action: decompose with explicit assignee, unblock, reassign, archive, or comment + narrate in chat. Stay at base; never mine/place. No unassigned ready cards."
  else
    continue_prompt_full="Continue in Minecraft. Run mc status, mc read_chat, mc goals.
$shared_rules
Execute the top-urgency goal: one focused subtask (3-8 mc commands), then report one short progress line."
    continue_prompt_minimal="Continue. Run: mc status, mc read_chat, mc goals.
Pick the top-urgency goal, execute one focused subtask (3-8 mc commands), report one progress line.
Only use mc commands. If blocked twice, mc help (or skill_view minecraft-<topic>) and switch goals."
  fi
  continue_prompt="$continue_prompt_full"

  if [ "$role" = "orchestrator" ]; then
    hermes_chat_flags=(-t "terminal,memory,skills")
  else
    hermes_chat_flags=(-t "terminal,memory" -s "minecraft-goals")
  fi

  agent_model="$(model_for_name "$name")"
  agent_provider="$(provider_for_name "$name")"
  ts_boot="$(date '+%Y-%m-%d %H:%M:%S')"
  {
    echo "[$ts_boot] ========== $name — Hermes agent startup =========="
    echo "[$ts_boot] Hermes -m \"$agent_model\" --provider \"$agent_provider\""
    echo "[$ts_boot] MC API: http://localhost:${port}"
    echo "[$ts_boot] (model/provider re-read from agent-models.json each round)"
  } > "$agent_log"
  if [ "$(printf '%s' "$MC_DEBUG_ENABLED" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
    mc_debug_env=("MC_DEBUG_LOG=$mc_debug_log")
  fi
  mkdir -p "$restricted_bin"
  if [ "${AGENT_ROUND_TIMEOUT_S:-0}" -gt 0 ]; then
    hermes_timeout_prefix=(perl -e 'alarm shift; exec @ARGV' "${AGENT_ROUND_TIMEOUT_S}")
  fi
  # Block diagnostic/system commands for worker agents only. Orchestrator needs
  # python3 (roster.py, blueprint-plan.py) and broader terminal for hermes kanban.
  if [ "$role" = "worker" ]; then
    for blocked_cmd in curl lsof netstat ss kill pkill grep awk sed cat file which \
      npm npx python python3 perl ruby \
      ls find head tail pwd \
      ps xargs pgrep top htop fuser nohup tee wc sort uniq dd; do
      cat > "$restricted_bin/$blocked_cmd" <<'STUB'
#!/bin/sh
echo "Blocked shell command. Use mc commands only." >&2
exit 126
STUB
      chmod +x "$restricted_bin/$blocked_cmd"
    done
  fi
  hermes_runtime_path="$restricted_bin:$BIN_DIR:$PATH"

  # Disable 'kill' bash builtin so the restricted-bin stub takes effect in agent subshells
  local bash_env_file="$agent_home/agent-bashenv.sh"
  cat > "$bash_env_file" <<'AGENTENV'
enable -n kill 2>/dev/null || true
AGENTENV

  rm -f "$session_ref_file"
  rm -f "$hermes_log"
  touch "$hermes_log"

  (
    export PATH="$BIN_DIR:$PATH"
    while ! curl -sf "http://localhost:${port}/health" >/dev/null 2>&1; do
      sleep 1
    done
    round=0
    cmd_ec=0
    while true; do
      round=$((round + 1))
      agent_model="$(model_for_name "$name")"
      agent_provider="$(provider_for_name "$name")"
      ts="$(date '+%Y-%m-%d %H:%M:%S')"
      health_json="$(curl -sf "http://localhost:${port}/health" 2>/dev/null || echo '{"ok":false,"connected":false}')"
      observe_json="$(curl -sf "http://localhost:${port}/observe" 2>/dev/null || echo '{}')"
      task_json="$(curl -sf "http://localhost:${port}/task" 2>/dev/null || echo '{}')"
      progress_json="$(printf '%s' "$observe_json" | python3 -c "
import sys,json,time
d=json.load(sys.stdin)
g=(d.get('goals') or [{}])[0]
t_raw=d.get('task') or {}
st=d.get('action_stats_5m') or {}
idle=d.get('idle_reason') or 'unknown'
ra=d.get('recent_actions') or []
recent=[f\"{a.get('action','?')}:{a.get('status','?')}\" for a in ra[-4:]]
err=d.get('last_api_error') or {}
em=err.get('message','')[:140] if err.get('message') else ''
top_errs=st.get('top_errors') or []
out={
  'ts':time.strftime('%Y-%m-%dT%H:%M:%S'),
  'round':${round},
  'agent':'${name}',
  'goal':g.get('id','none'),
  'urgency':g.get('urgency'),
  'task':{'action':t_raw.get('action','idle'),'status':t_raw.get('status','idle'),'elapsed_s':t_raw.get('elapsed_s')},
  'idle_reason':idle,
  'stats_5m':{'total':st.get('total',0),'done':st.get('done',0),'failed':st.get('failed',0),'err_pct':st.get('error_rate_pct',0),'done_per_min':st.get('done_per_min',0)},
  'recent':recent,
  'last_error':em or None,
  'top_errors':[e.get('msg','')[:80] for e in top_errs[:3]] if top_errs else None,
}
print(json.dumps({k:v for k,v in out.items() if v is not None},separators=(',',':')))" 2>/dev/null || echo '{"round":'"$round"',"agent":"'"$name"'","error":"observe_parse_failed"}')"
      top_goal_hint="$(printf '%s' "$progress_json" | python3 -c "import sys,json; d=json.load(sys.stdin); g=d.get('goal','none'); u=d.get('urgency'); print(f'{g} (u={u})' if u is not None else g)" 2>/dev/null || echo 'unknown')"
      recent_summary="$(printf '%s' "$progress_json" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('recent',[]); print(' | '.join(r) if r else 'none')" 2>/dev/null || echo 'none')"
      task_summary="$(printf '%s' "$progress_json" | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('task',{}); print(f\"{t.get('action','idle')}:{t.get('status','idle')}:{t.get('elapsed_s','')}\")" 2>/dev/null || echo 'idle')"
      echo "[$ts] round=$round agent=$name model=$agent_model provider=$agent_provider api=http://localhost:${port}" >> "$agent_log"
      echo "[$ts] top_goal=$top_goal_hint" >> "$agent_log"
      printf '%s\n' "$progress_json" >> "$progress_log"
      echo "[$ts] Plan: focus=$top_goal_hint | task=$task_summary | recent=$recent_summary" >> "$hermes_log"
      if [ "$round" -eq 1 ]; then
        if "${hermes_timeout_prefix[@]}" env MODEL= PROVIDER= HERMES_MODEL= HERMES_PROVIDER= PATH="$hermes_runtime_path" BASH_ENV="$bash_env_file" HERMES_HOME="$agent_home" HERMES_KANBAN_DB="$kanban_db" HERMES_KANBAN_BOARD="$kanban_board" HERMES_KANBAN_WORKSPACES_ROOT="$kanban_workspaces" MC_API_URL="http://localhost:${port}" _MC_API_URL_LOCKED="http://localhost:${port}" MC_USERNAME="$name" "${mc_debug_env[@]}" \
          hermes chat --yolo --max-turns 500 -m "$agent_model" --provider "$agent_provider" "${hermes_chat_flags[@]}" \
          -q "$prompt" 2>> "$agent_err_log" \
          | awk '$0 ~ /^[[:space:]]*$/ {next} index($0,"╭")==1 {next} index($0,"╰")==1 {next} index($0,"│")==1 {next} index($0,"  ┊")==1 {next} $0=="Initializing agent..." {next} $0 ~ /^─+$/ {next} $0=="Resume this session with:" {next} $0 ~ /^Session:[[:space:]]+/ {next} $0 ~ /^Duration:[[:space:]]+/ {next} $0 ~ /^Messages:[[:space:]]+/ {next} /Resumed session/ {next} /^Query:/ {next} /^hermes --resume/ {next} /commits behind/ {next} /^⚠/ {next} {print; fflush()}' >> "$agent_log"; then
          cmd_ec=0
        else
          cmd_ec=$?
        fi
        sid=$(rg -o "Session: [0-9]{8}_[0-9]{6}_[a-f0-9]+" "$agent_log" | awk '{print $2}' | tail -n 1 || true)
        [ -n "${sid:-}" ] && printf '%s\n' "$sid" > "$session_ref_file"
      else
        continue_prompt_round="$continue_prompt_full"
        if [ "$(printf '%s' "$CONTEXT_MINIMAL_CONTINUE" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
          if [ "$CONTEXT_REFRESH_EVERY_ROUNDS" -gt 0 ] && [ $((round % CONTEXT_REFRESH_EVERY_ROUNDS)) -ne 0 ]; then
            continue_prompt_round="$continue_prompt_minimal"
            if [ "$role" != "orchestrator" ]; then
              continue_prompt_round="${continue_prompt_round}
Current focus hint: ${top_goal_hint}"
            fi
          fi
        fi
        cont_target=""
        if [ -f "$session_ref_file" ]; then
          cont_target="$(cat "$session_ref_file" 2>/dev/null || true)"
        fi
        if [ -n "${cont_target:-}" ]; then
          if "${hermes_timeout_prefix[@]}" env MODEL= PROVIDER= HERMES_MODEL= HERMES_PROVIDER= PATH="$hermes_runtime_path" BASH_ENV="$bash_env_file" HERMES_HOME="$agent_home" HERMES_KANBAN_DB="$kanban_db" HERMES_KANBAN_BOARD="$kanban_board" HERMES_KANBAN_WORKSPACES_ROOT="$kanban_workspaces" MC_API_URL="http://localhost:${port}" _MC_API_URL_LOCKED="http://localhost:${port}" MC_USERNAME="$name" "${mc_debug_env[@]}" \
            hermes chat --yolo --max-turns 500 -m "$agent_model" --provider "$agent_provider" "${hermes_chat_flags[@]}" \
            --continue "$cont_target" \
            -q "$continue_prompt_round" 2>> "$agent_err_log" \
            | awk '$0 ~ /^[[:space:]]*$/ {next} index($0,"╭")==1 {next} index($0,"╰")==1 {next} index($0,"│")==1 {next} index($0,"  ┊")==1 {next} $0=="Initializing agent..." {next} $0 ~ /^─+$/ {next} $0=="Resume this session with:" {next} $0 ~ /^Session:[[:space:]]+/ {next} $0 ~ /^Duration:[[:space:]]+/ {next} $0 ~ /^Messages:[[:space:]]+/ {next} /Resumed session/ {next} /^Query:/ {next} /^hermes --resume/ {next} /commits behind/ {next} /^⚠/ {next} {print; fflush()}' >> "$agent_log"; then
            cmd_ec=0
          else
            cmd_ec=$?
          fi
        else
          if "${hermes_timeout_prefix[@]}" env MODEL= PROVIDER= HERMES_MODEL= HERMES_PROVIDER= PATH="$hermes_runtime_path" BASH_ENV="$bash_env_file" HERMES_HOME="$agent_home" HERMES_KANBAN_DB="$kanban_db" HERMES_KANBAN_BOARD="$kanban_board" HERMES_KANBAN_WORKSPACES_ROOT="$kanban_workspaces" MC_API_URL="http://localhost:${port}" _MC_API_URL_LOCKED="http://localhost:${port}" MC_USERNAME="$name" "${mc_debug_env[@]}" \
            hermes chat --yolo --max-turns 500 -m "$agent_model" --provider "$agent_provider" "${hermes_chat_flags[@]}" \
            -q "$continue_prompt_round" 2>> "$agent_err_log" \
            | awk '$0 ~ /^[[:space:]]*$/ {next} index($0,"╭")==1 {next} index($0,"╰")==1 {next} index($0,"│")==1 {next} index($0,"  ┊")==1 {next} $0=="Initializing agent..." {next} $0 ~ /^─+$/ {next} $0=="Resume this session with:" {next} $0 ~ /^Session:[[:space:]]+/ {next} $0 ~ /^Duration:[[:space:]]+/ {next} $0 ~ /^Messages:[[:space:]]+/ {next} /Resumed session/ {next} /^Query:/ {next} /^hermes --resume/ {next} /commits behind/ {next} /^⚠/ {next} {print; fflush()}' >> "$agent_log"; then
            cmd_ec=0
          else
            cmd_ec=$?
          fi
        fi
        if [ -z "${cont_target:-}" ]; then
          sid=$(rg -o "Session: [0-9]{8}_[0-9]{6}_[a-f0-9]+" "$agent_log" | awk '{print $2}' | tail -n 1 || true)
          [ -n "${sid:-}" ] && printf '%s\n' "$sid" > "$session_ref_file"
        fi
      fi
      ts_end="$(date '+%Y-%m-%d %H:%M:%S')"
      echo "[$ts_end] round=$round exit_code=$cmd_ec" >> "$agent_log"
      if [ "$cmd_ec" -ne 0 ]; then
        echo "[$ts_end] round=$round failed; check $agent_err_log and $mc_debug_log" >> "$agent_log"
        echo "[$ts_end] Update: round=$round failed (exit=$cmd_ec)." >> "$hermes_log"
      else
        echo "[$ts_end] Update: round=$round complete (exit=0)." >> "$hermes_log"
      fi
      if [ "$role" = "orchestrator" ]; then
        sleep 60
      else
        sleep 5
      fi
    done
  ) &
  local pid="$!"
  echo "$pid" > "$pidf"
  cleanup_legacy_pid_files agent "$name"
  echo "[agent] started $name on :$port (pid $pid)"
  echo "[agent] $name → Hermes model: $agent_model   provider: $agent_provider   (log: agent-${name_lower}.log)"
}

stop_kind() {
  local type="$1"
  local name="$2"
  local any_tracked=false
  local any_stopped=false

  while IFS= read -r pidf; do
    [ -z "$pidf" ] && continue
    [ -f "$pidf" ] || continue
    any_tracked=true
    local pid
    pid="$(cat "$pidf" 2>/dev/null || true)"
    if [ -n "$pid" ] && is_pid_alive "$pid"; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      if is_pid_alive "$pid"; then
        kill -9 "$pid" 2>/dev/null || true
        sleep 0.5
      fi
      any_stopped=true
      echo "[$type] stopped $name (pid $pid)"
    fi
    # Only remove PID file after process is confirmed dead
    if [ -z "$pid" ] || ! is_pid_alive "$pid"; then
      rm -f "$pidf"
    fi
  done < <(pid_file_candidates "$type" "$name")

  if [ "$any_tracked" = false ]; then
    echo "[$type] $name not tracked"
  elif [ "$any_stopped" = false ]; then
    echo "[$type] $name not running"
  fi

  if [ "$type" = "agent" ]; then
    local name_lower="${name,,}"
    local fallback_pids
    fallback_pids="$(pgrep -f "\\.hermes-landfolk-${name_lower}|--continue landfolk-${name_lower}|MC_USERNAME=${name}" || true)"
    if [ -n "$fallback_pids" ]; then
      for pid in $fallback_pids; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 1
      fallback_pids="$(pgrep -f "\\.hermes-landfolk-${name_lower}|--continue landfolk-${name_lower}|MC_USERNAME=${name}" || true)"
      if [ -n "$fallback_pids" ]; then
        for pid in $fallback_pids; do
          kill -9 "$pid" 2>/dev/null || true
        done
      fi
      echo "[agent] force-stopped untracked $name process(es)"
    fi

    # Extra safety: catch orphaned hermes chat loops by env snapshot (PPID may be 1).
    local orphan_agent_pids
    orphan_agent_pids="$(
      ps eww -ax -o pid=,command= \
      | awk -v home=".hermes-landfolk-${name_lower}" '$0 ~ /hermes chat/ && index($0, home) {print $1}'
    )"
    if [ -n "$orphan_agent_pids" ]; then
      for pid in $orphan_agent_pids; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 1
      orphan_agent_pids="$(
        ps eww -ax -o pid=,command= \
        | awk -v home=".hermes-landfolk-${name_lower}" '$0 ~ /hermes chat/ && index($0, home) {print $1}'
      )"
      if [ -n "$orphan_agent_pids" ]; then
        for pid in $orphan_agent_pids; do
          kill -9 "$pid" 2>/dev/null || true
        done
      fi
      echo "[agent] force-stopped orphaned $name hermes process(es)"
    fi
  fi

  if [ "$type" = "bot" ]; then
    local port
    port="$(port_for_name "$name")"
    if [ -n "$port" ]; then
      kill_listener_on_port "$port"
    fi
    # Extra safety: catch orphan node server.js bound to this profile via env.
    local orphan_bot_pids
    orphan_bot_pids="$(
      ps eww -ax -o pid=,command= \
      | awk -v user="MC_USERNAME=${name}" '$0 ~ /node server\.js/ && index($0, user) {print $1}'
    )"
    if [ -n "$orphan_bot_pids" ]; then
      for pid in $orphan_bot_pids; do
        kill "$pid" 2>/dev/null || true
      done
      sleep 1
      orphan_bot_pids="$(
        ps eww -ax -o pid=,command= \
        | awk -v user="MC_USERNAME=${name}" '$0 ~ /node server\.js/ && index($0, user) {print $1}'
      )"
      if [ -n "$orphan_bot_pids" ]; then
        for pid in $orphan_bot_pids; do
          kill -9 "$pid" 2>/dev/null || true
        done
      fi
      echo "[bot] force-stopped orphaned $name node process(es)"
    fi
  elif [ "$type" = "agent" ]; then
    local session_ref_file
    local name_lower="${name,,}"
    session_ref_file="$STATE_DIR/session-${name_lower}.txt"
    rm -f "$session_ref_file"
  fi
}

stop_non_selected_agents() {
  local selected=("$@")
  for name in "${ALL_AGENT_NAMES[@]}"; do
    if ! contains_name "$name" "${selected[@]}"; then
      stop_kind watchdog "$name"
      stop_kind agent "$name"
      stop_kind bot "$name"
      local port
      port="$(port_for_name "$name")"
      if [ -n "$port" ]; then
        kill_listener_on_port "$port"
      fi
    fi
  done
}

show_status() {
  local type="$1"
  local name="$2"
  local found=false
  while IFS= read -r pidf; do
    [ -z "$pidf" ] && continue
    [ -f "$pidf" ] || continue
    local pid
    pid="$(cat "$pidf" 2>/dev/null || true)"
    if [ -n "$pid" ] && is_pid_alive "$pid"; then
      echo "[$type] $name RUNNING pid $pid"
      found=true
      break
    fi
  done < <(pid_file_candidates "$type" "$name")
  if [ "$found" = false ]; then
    echo "[$type] $name STOPPED"
  fi
}

mkdir -p "$LOG_DIR" "$STATE_DIR"
[ -d "$BOT_DIR/node_modules" ] || { echo "Installing bot deps..."; (cd "$BOT_DIR" && npm install --no-audit --no-fund); }

case "$COMMAND" in
  start)
    ensure_hermes
    echo "Starting profiles=${AGENTS[*]} on $MC_HOST:$MC_PORT"
    echo "Agent models (${AGENT_MODELS_JSON})"
    for _p in "${AGENTS[@]}"; do
      echo "  ${_p}: $(model_for_name "$_p") ($(provider_for_name "$_p"))"
    done

    # Single-script ownership: stop any non-selected managed agents first (unless disabled).
    if [ "$STOP_OTHERS" = true ]; then
      stop_non_selected_agents "${AGENTS[@]}"
    fi

    connected_agents=()
    for name in "${AGENTS[@]}"; do
      port="$(port_for_name "$name")"
      [ -z "$port" ] && { echo "Unknown port mapping for $name"; exit 1; }
      start_bot "$name" "$port"
      _stag=2
      if [ "${#AGENTS[@]}" -ge 2 ]; then
        _stag="${BOT_START_STAGGER_S:-5}"
      fi
      sleep "$_stag"
      if wait_for_bot_connected "$name" "$port"; then
        connected_agents+=("$name")
      else
        echo "[start] skipping Hermes agent for $name because bot is not connected"
      fi
    done
    for name in "${connected_agents[@]}"; do
      port="$(port_for_name "$name")"
      # Watchdog is critical infrastructure — keep it independent of the
      # continuous-agent launch. Previously, a `start_agent` failure (e.g.
      # missing prompt file under set -euo pipefail) would abort the loop
      # and leave the bot un-watched, so a single disconnect was terminal.
      if [ "$NO_AGENT" = true ]; then
        echo "[start] $name agent skipped (--no-agent)"
      else
        start_agent "$name" "$port" || echo "[start] $name agent failed (continuing — watchdog still arms)"
      fi
      start_watchdog "$name" "$port" || echo "[start] $name watchdog FAILED to launch — bot will not auto-reconnect"
      sleep 2
    done
    echo "Started. Logs: $LOG_DIR/bot-*.log and $LOG_DIR/agent-*.log"
    echo "Command center: http://127.0.0.1:${DASHBOARD_PORT:-3000}  (./start-dashboard.sh)"
    for name in "${connected_agents[@]}"; do
      name_lower="${name,,}"
      echo "[$name] agent log:   tail -f \"$LOG_DIR/agent-${name_lower}.log\""
      echo "[$name] hermes log:  tail -f \"$LOG_DIR/hermes-${name_lower}.log\""
      echo "[$name] progress:    tail -f \"$LOG_DIR/progress-${name_lower}.log\""
      echo "[$name] session:     scripts/watch-agent.py --agent ${name_lower} --tail 30"
    done
    ;;
  watchdog)
    # Launch JUST the watchdog for the named profiles (bot must already be
    # up). Used by landfolk-session.sh ensure_watchdog when a start aborted
    # before the watchdog could be armed.
    for name in "${AGENTS[@]}"; do
      port="$(port_for_name "$name")"
      [ -z "$port" ] && { echo "Unknown port mapping for $name"; exit 1; }
      start_watchdog "$name" "$port"
    done
    ;;
  stop)
    echo "Stopping profiles=${AGENTS[*]}"
    for name in "${AGENTS[@]}"; do
      stop_kind watchdog "$name"
    done
    for name in "${AGENTS[@]}"; do
      stop_kind agent "$name"
    done
    for name in "${AGENTS[@]}"; do
      stop_kind bot "$name"
    done
    if [ "$FORCE" = true ]; then
      for name in "${AGENTS[@]}"; do
        force_stop_profile "$name"
      done
    fi
    ;;
  status)
    for name in "${AGENTS[@]}"; do
      show_status bot "$name"
      show_status agent "$name"
      show_status watchdog "$name"
      port="$(port_for_name "$name")"
      if [ -n "$port" ]; then
        health_payload="$(curl -sf "http://localhost:${port}/health" 2>/dev/null || true)"
        if [ -n "$health_payload" ]; then
          health_user="$(printf '%s' "$health_payload" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('username',''))" 2>/dev/null || true)"
          if [ -n "$health_user" ] && [ "$health_user" != "$name" ]; then
            echo "[health] $name :$port OK as $health_user"
          else
            echo "[health] $name :$port OK"
          fi
        else
          echo "[health] $name :$port DOWN"
        fi
      fi
    done
    ;;
  *)
    echo "Unknown command: $COMMAND"
    usage
    exit 1
    ;;
esac
