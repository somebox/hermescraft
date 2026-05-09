#!/usr/bin/env bash
# landfolk-bodies-only.sh — Phase-2 bodies launcher.
#
# Starts two Mineflayer bodies (Flint:3001, Gatherer:3002) against the
# Minecraft server. Does NOT start any Hermes brain — workers are spawned
# by the kanban dispatcher per card.
#
# Usage:
#   scripts/landfolk-bodies-only.sh [start|stop|status] [--daemon] [--kill-port]
#
# Default command is "start --daemon".
#
# Environment:
#   MC_HOST          Minecraft server host (default: 192.168.1.202 / ubuntu-host)
#   MC_PORT          Minecraft TCP port    (default: 25565)
#   FLINT_PORT       Flint API port        (default: 3001)
#   GATHERER_PORT    Gatherer API port     (default: 3002)
#   FAIR_PLAY        Fair-play mode        (default: true)
#   LOG_DIR          Log/PID directory     (default: /tmp/hermescraft)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOT_DIR="$ROOT/bot"

MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"
FLINT_PORT="${FLINT_PORT:-3001}"
GATHERER_PORT="${GATHERER_PORT:-3002}"
FAIR_PLAY="${FAIR_PLAY:-true}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
PID_DIR="$LOG_DIR/landfolk-bodies"

CMD="${1:-start}"
shift || true
DAEMON=true
KILL_PORT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --daemon)    DAEMON=true; shift ;;
    --foreground|--fg) DAEMON=false; shift ;;
    --kill-port) KILL_PORT=true; shift ;;
    -h|--help)
      sed -n '1,20p' "$0" | tail -n +2
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$LOG_DIR" "$PID_DIR"

bot_pid_file()  { echo "$PID_DIR/bot-${1,,}.pid"; }
bot_log_file()  { echo "$LOG_DIR/bot-${1,,}.log"; }

is_alive() { kill -0 "$1" 2>/dev/null; }

free_port() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 || return 0
  local pids
  pids="$(lsof -ti TCP:"$port" 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  pids="$(lsof -ti TCP:"$port" 2>/dev/null || true)"
  [ -n "$pids" ] && for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
}

start_bot() {
  local name="$1"
  local port="$2"
  local pidf log
  pidf="$(bot_pid_file "$name")"
  log="$(bot_log_file "$name")"

  if [ -f "$pidf" ] && is_alive "$(cat "$pidf")"; then
    echo "[bot] $name already running (pid $(cat "$pidf"))"
    return 0
  fi

  if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
    if [ "$KILL_PORT" = true ]; then
      echo "[bot] $name: freeing :$port"
      free_port "$port"
      sleep 1
    else
      echo "[bot] $name: something is already on :$port — pass --kill-port to take it"
      return 1
    fi
  fi

  echo "[bot] starting $name on :$port → $MC_HOST:$MC_PORT"

  if [ "$DAEMON" = true ]; then
    (
      cd "$BOT_DIR"
      MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" \
        MC_USERNAME="$name" API_PORT="$port" \
        FAIR_PLAY="$FAIR_PLAY" \
        node server.js
    ) >"$log" 2>&1 &
    local pid="$!"
    echo "$pid" > "$pidf"
    echo "[bot] $name pid=$pid log=$log"
  else
    cd "$BOT_DIR"
    exec env \
      MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" \
      MC_USERNAME="$name" API_PORT="$port" \
      FAIR_PLAY="$FAIR_PLAY" \
      node server.js
  fi
}

wait_healthy() {
  local name="$1"
  local port="$2"
  local timeout="${3:-30}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
      local connected
      connected="$(curl -sf "http://localhost:$port/health" 2>/dev/null \
        | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('connected', False)).lower())" 2>/dev/null || echo "false")"
      if [ "$connected" = "true" ]; then
        echo "[bot] $name connected on :$port"
        return 0
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "[bot] $name failed to connect on :$port within ${timeout}s"
  return 1
}

stop_bot() {
  local name="$1"
  local port="$2"
  local pidf
  pidf="$(bot_pid_file "$name")"

  if [ -f "$pidf" ]; then
    local pid
    pid="$(cat "$pidf" 2>/dev/null)"
    if [ -n "$pid" ] && is_alive "$pid"; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      is_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
      echo "[bot] $name stopped (pid $pid)"
    fi
    rm -f "$pidf"
  fi
  free_port "$port"
}

status_bot() {
  local name="$1"
  local port="$2"
  local pidf
  pidf="$(bot_pid_file "$name")"

  local pid_state="STOPPED"
  if [ -f "$pidf" ] && is_alive "$(cat "$pidf")"; then
    pid_state="RUNNING pid=$(cat "$pidf")"
  fi

  local health="DOWN"
  local payload
  payload="$(curl -sf --max-time 2 "http://localhost:$port/health" 2>/dev/null || true)"
  if [ -n "$payload" ]; then
    local connected username
    connected="$(printf '%s' "$payload" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected', False))" 2>/dev/null || echo "False")"
    username="$(printf '%s' "$payload" | python3 -c "import sys,json; print(json.load(sys.stdin).get('username', ''))" 2>/dev/null || echo "")"
    health="UP connected=$connected as=$username"
  fi
  echo "[bot] $name :$port  $pid_state  $health"
}

case "$CMD" in
  start)
    start_bot Flint    "$FLINT_PORT"
    sleep 2
    start_bot Gatherer "$GATHERER_PORT"
    if [ "$DAEMON" = true ]; then
      sleep 2
      wait_healthy Flint    "$FLINT_PORT"    30 || true
      wait_healthy Gatherer "$GATHERER_PORT" 30 || true
      echo
      status_bot Flint    "$FLINT_PORT"
      status_bot Gatherer "$GATHERER_PORT"
      echo
      echo "logs: $LOG_DIR/bot-flint.log  $LOG_DIR/bot-gatherer.log"
      echo "stop: $0 stop"
    fi
    ;;
  stop)
    stop_bot Flint    "$FLINT_PORT"
    stop_bot Gatherer "$GATHERER_PORT"
    ;;
  status)
    status_bot Flint    "$FLINT_PORT"
    status_bot Gatherer "$GATHERER_PORT"
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start ${KILL_PORT:+--kill-port}
    ;;
  *)
    echo "usage: $0 [start|stop|status|restart] [--daemon|--foreground] [--kill-port]" >&2
    exit 1
    ;;
esac
