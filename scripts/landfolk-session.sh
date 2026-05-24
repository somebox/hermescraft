#!/usr/bin/env bash
# landfolk-session — one-stop session manager for the kanban experiment stack
#
# Wraps scripts/landfolk-control.sh for bot lifecycle and manages the
# steward daemons (chat-listener, supervisor) so the human operator can
# bring up, tear down, status-check, and recover the whole experiment
# with single commands.
#
# Usage:
#   ./scripts/landfolk-session.sh up [--profiles flint,mason] [--no-listener] [--no-supervisor] [--no-pauser]
#     Brings up the bot set + steward daemons, and writes an "active roster"
#     file. Cards on the kanban board assigned to profiles NOT in this roster
#     get auto-routed to re44 by the inactive-cards-pauser (prevents the
#     gateway dispatcher from spawning unmanaged workers for offline bots).
#   ./scripts/landfolk-session.sh down [--profiles ...] [--keep-listener] [--keep-supervisor]
#     Full down (no --profiles): reclaims all running landfolk-ops cards, stops
#     pauser + bots. Hermes gateway keeps running unless --stop-gateway.
#     --stop-gateway   also run `hermes gateway stop` (dispatcher + dashboard)
#     --no-reclaim     skip kanban reclaim (bots/daemons only)
#   ./scripts/landfolk-session.sh restart <target>
#     target ∈ flint|mason|gatherer|all-bots|listener|supervisor|pauser|all
#   ./scripts/landfolk-session.sh status [--json]
#   ./scripts/landfolk-session.sh fix <issue> [args]
#     issue ∈ reconnect <bot> | clean | tp <bot> <x> <y> <z> | unstick <bot>
#   ./scripts/landfolk-session.sh logs [agents|<component>] [opts...]
#     no arg / "agents" → aggregated, color-coded live tail of active agents
#     component ∈ flint|mason|gatherer|steward|listener|supervisor|gateway (single log file)
#     opts (agents mode):
#       --tail N         backfill N messages per profile before following (default 20)
#       --profiles a,b   restrict to a comma-separated profile list (default: $PROFILES_DEFAULT)
#       --no-bot-logs    suppress bot-log fold-in (chat / connect / kick) — agent thoughts only
#       --quiet, -q      hide normal tool output and collapse tool-call lists;
#                        keeps thoughts + errors. Stack with --no-bot-logs for minimum noise.
#       --no-color       disable ANSI coloring (also disabled when stdout isn't a TTY)
#     opts (single-component mode):
#       --tail N         lines of history to print (default 20)
#       --follow | -f    tail -f the log
#   ./scripts/landfolk-session.sh chat <bot> "<message>"
#
# Defaults (override via env):
#   MC_HOST=192.168.1.202
#   BOT_MOVEMENT_PROFILE=slow
#   WATCHDOG_CONNECT_ONLY=1
#   PROFILES_DEFAULT=flint,mason
#   LOG_DIR=/tmp/hermescraft
#   STATE_DIR=$LOG_DIR/session-state

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# Defaults — all env-overridable
MC_HOST="${MC_HOST:-192.168.1.202}"
BOT_MOVEMENT_PROFILE="${BOT_MOVEMENT_PROFILE:-slow}"
WATCHDOG_CONNECT_ONLY="${WATCHDOG_CONNECT_ONLY:-1}"
PROFILES_DEFAULT="${PROFILES_DEFAULT:-flint,mason,steward}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
STATE_DIR="${STATE_DIR:-$LOG_DIR/session-state}"
mkdir -p "$STATE_DIR"

# Active-profile roster: written by `up`, removed by `down`. The inactive-
# cards-pauser daemon reads this to know which assignees are currently
# meant to be in-game; cards assigned to anyone else get auto-routed to re44.
ROSTER_FILE="${ACTIVE_PROFILES_FILE:-$LOG_DIR/active-profiles}"

# Port assignments — match data/agent-models.json
declare -A BOT_PORTS=( [flint]=3002 [mason]=3003 [gatherer]=3001 [steward]=3005 )
declare -A VIEWER_PORTS=( [flint]=4002 [mason]=4003 [gatherer]=4001 [steward]=4005 )

# ANSI helpers
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RST=""
fi
ok() { echo "  ${C_OK}✓${C_RST} $*"; }
warn() { echo "  ${C_WARN}!${C_RST} $*"; }
err() { echo "  ${C_ERR}✗${C_RST} $*"; }
dim() { echo "  ${C_DIM}$*${C_RST}"; }
h1() { echo; echo "── $* ──"; }

usage() {
  sed -n '2,30p' "$0" | sed -E 's/^# ?//'
  exit "${1:-0}"
}

# ─── Helpers ───────────────────────────────────────────────────────────────

bot_health() {
  # Args: profile_name
  # Echoes "connected=<bool>;pos=<x,y,z>;holding=<item>;uptime=<s>;username=<u>"
  # Empty if not reachable.
  local port="${BOT_PORTS[$1]:-}"
  [ -z "$port" ] && return 1
  curl -sf "http://127.0.0.1:$port/health" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    pos = d.get('position') or {}
    print(f\"connected={d.get('connected')};pos={pos.get('x',0):.1f},{pos.get('y',0):.1f},{pos.get('z',0):.1f};holding={d.get('holding') or 'none'};uptime={d.get('uptime_sec',0)};username={d.get('username','?')}\")
except Exception:
    pass
" 2>/dev/null
}

bot_force_reconnect() {
  local profile="$1"
  local port="${BOT_PORTS[$profile]:-}"
  [ -z "$port" ] && { err "unknown profile: $profile"; return 1; }
  curl -sf -X POST "http://127.0.0.1:$port/connect" \
    -H "Content-Type: application/json" \
    -d '{"force":true}' >/dev/null 2>&1 \
    && ok "force-reconnect sent to $profile (:$port)" \
    || err "force-reconnect FAILED for $profile"
}

bot_send_chat() {
  local profile="$1"; shift
  local msg="$*"
  local port="${BOT_PORTS[$profile]:-}"
  [ -z "$port" ] && { err "unknown profile: $profile"; return 1; }
  MC_API_URL="http://localhost:$port" "$SCRIPT_DIR/bin/mc" chat "$msg" 2>&1 | head -3
}

# Missing pidfile must not fail under set -e (cat exits 1).
daemon_pid() { cat "$STATE_DIR/$1.pid" 2>/dev/null || true; }
daemon_alive() {
  local pid; pid="$(daemon_pid "$1")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

daemon_start() {
  # Args: name script [env_overrides...]
  local name="$1"; local script="$2"; shift 2
  if daemon_alive "$name"; then
    warn "$name already running (pid $(daemon_pid "$name"))"
    return 0
  fi
  local log="$LOG_DIR/$name.log"
  (
    cd "$SCRIPT_DIR"
    nohup python3 -u "$script" >"$log" 2>&1 &
    echo $! > "$STATE_DIR/$name.pid"
    disown
  )
  sleep 1
  if daemon_alive "$name"; then
    ok "$name started (pid $(daemon_pid "$name")) — log $log"
  else
    err "$name failed to start; see $log"
    tail -5 "$log" 2>/dev/null | sed 's/^/    /'
  fi
}

daemon_stop() {
  local name="$1"
  local pid; pid="$(daemon_pid "$name")"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    dim "$name not running"
    rm -f "$STATE_DIR/$name.pid"
    # Also catch any process from a previous unclean shutdown
    pkill -f "scripts/$name.py" 2>/dev/null && warn "killed orphan $name process(es)" || true
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    if kill -9 "$pid" 2>/dev/null; then
      warn "$name (pid $pid) force-killed (SIGKILL)"
    else
      err "$name (pid $pid) still running — could not SIGKILL"
    fi
  else
    ok "$name (pid $pid) stopped"
  fi
  rm -f "$STATE_DIR/$name.pid"
  # Belt-and-suspenders for double-launch cases
  pkill -f "scripts/$name.py" 2>/dev/null || true
}

profiles_list() {
  local csv="${1:-$PROFILES_DEFAULT}"
  echo "$csv" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$'
}

bot_start_one() {
  local profile="$1"
  local port="${BOT_PORTS[$profile]:-}"
  local vport="${VIEWER_PORTS[$profile]:-}"
  [ -z "$port" ] && { err "unknown profile: $profile"; return 1; }
  MC_HOST="$MC_HOST" \
    VIEWER_PORT="$vport" \
    BOT_MOVEMENT_PROFILE="$BOT_MOVEMENT_PROFILE" \
    WATCHDOG_CONNECT_ONLY="$WATCHDOG_CONNECT_ONLY" \
    "$SCRIPT_DIR/scripts/landfolk-control.sh" enable --profiles "$profile" >>"$LOG_DIR/landfolk-control.log" 2>&1
  # Wait for the bot to land in Minecraft
  local i=0
  until curl -sf "http://127.0.0.1:$port/health" 2>/dev/null \
        | python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get('connected')==True else 1)" 2>/dev/null; do
    i=$((i + 1)); [ $i -gt 30 ] && { err "$profile didn't connect within 60s"; return 1; }
    sleep 2
  done
  # Strip the continuous landfolk agent the start re-spawned (we run kanban-only)
  local pf="/tmp/hermescraft/landfolk-control/agent-$profile.pid"
  if [ -f "$pf" ]; then
    kill "$(cat "$pf")" 2>/dev/null && true
    rm -f "$pf"
  fi
  # Defensive: confirm the watchdog actually came up. If landfolk-control
  # aborted mid-launch (e.g. missing prompt file under set -e), the watchdog
  # might be missing — without it, any kick leaves the bot offline permanently.
  ensure_watchdog "$profile" "$port"
  ok "$profile up (port=$port, viewer=:$vport, slow-mode, connect-only watchdog)"
}

ensure_watchdog() {
  local profile="$1" port="$2"
  local wd_pf="/tmp/hermescraft/landfolk-control/watchdog-$profile.pid"
  if [ -f "$wd_pf" ] && kill -0 "$(cat "$wd_pf")" 2>/dev/null; then
    return 0
  fi
  warn "$profile watchdog missing — launching directly"
  WATCHDOG_CONNECT_ONLY="$WATCHDOG_CONNECT_ONLY" \
    "$SCRIPT_DIR/scripts/landfolk-control.sh" watchdog --profiles "$profile" \
    >>"$LOG_DIR/landfolk-control.log" 2>&1
  sleep 1
  if [ -f "$wd_pf" ] && kill -0 "$(cat "$wd_pf")" 2>/dev/null; then
    ok "$profile watchdog now running (pid $(cat "$wd_pf"))"
  else
    err "$profile watchdog still missing — manual intervention needed"
  fi
}

bot_stop_one() {
  local profile="$1"
  cd "$SCRIPT_DIR" && ./scripts/landfolk-control.sh stop --profiles "$profile" >>"$LOG_DIR/landfolk-control.log" 2>&1
  ok "$profile stopped"
}

reclaim_active_for_assignee() {
  # Find any cards on landfolk-ops currently running under this assignee
  # and reclaim them so the worker exits cleanly before we touch the bot.
  local assignee="$1"
  local board="landfolk-ops"
  hermes kanban --board "$board" list --assignee "$assignee" 2>/dev/null \
    | awk '$3=="running"{print $2}' \
    | while read -r tid; do
        [ -z "$tid" ] && continue
        hermes kanban --board "$board" reclaim "$tid" --reason "landfolk-session restart $assignee" >/dev/null 2>&1 \
          && dim "reclaimed $tid"
      done
}

reclaim_all_running() {
  local board="landfolk-ops"
  hermes kanban --board "$board" list 2>/dev/null \
    | awk '$3=="running"{print $2}' \
    | while read -r tid; do
        [ -z "$tid" ] && continue
        hermes kanban --board "$board" reclaim "$tid" --reason "landfolk-session down" >/dev/null 2>&1 \
          && dim "reclaimed $tid"
      done || true
}

# ─── Subcommands ───────────────────────────────────────────────────────────

cmd_up() {
  local profiles_csv="$PROFILES_DEFAULT"
  local with_listener=1
  local with_supervisor=1
  local with_pauser=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --profiles) profiles_csv="$2"; shift 2 ;;
      --no-listener) with_listener=0; shift ;;
      --no-supervisor) with_supervisor=0; shift ;;
      --no-pauser) with_pauser=0; shift ;;
      *) err "unknown flag: $1"; exit 1 ;;
    esac
  done

  h1 "starting bots"
  while read -r p; do
    bot_start_one "$p"
  done < <(profiles_list "$profiles_csv")

  # Publish the active roster — read by inactive-cards-pauser so cards
  # assigned to profiles we didn't start get auto-routed to re44 rather
  # than letting the gateway spawn an unmanaged worker that may launch
  # its own bot body.
  profiles_list "$profiles_csv" >"$ROSTER_FILE"
  ok "active roster → $ROSTER_FILE ($(wc -l <"$ROSTER_FILE" | tr -d ' ') profiles)"

  if [ "$with_listener" = 1 ]; then
    h1 "starting steward chat listener"
    daemon_start "steward-chat-listener" "$SCRIPT_DIR/scripts/steward-chat-listener.py"
  fi
  if [ "$with_supervisor" = 1 ]; then
    h1 "starting steward supervisor"
    daemon_start "steward-supervisor" "$SCRIPT_DIR/scripts/steward-supervisor.py"
  fi
  if [ "$with_pauser" = 1 ]; then
    h1 "starting inactive-cards pauser"
    ACTIVE_PROFILES_FILE="$ROSTER_FILE" \
      daemon_start "inactive-cards-pauser" "$SCRIPT_DIR/scripts/inactive-cards-pauser.py"
  fi

  h1 "ready"
  cmd_status
}

cmd_down() {
  local profiles_csv=""
  local keep_listener=0
  local keep_supervisor=0
  local stop_gateway=0
  local do_reclaim=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --profiles) profiles_csv="$2"; shift 2 ;;
      --keep-listener) keep_listener=1; shift ;;
      --keep-supervisor) keep_supervisor=1; shift ;;
      --stop-gateway) stop_gateway=1; shift ;;
      --no-reclaim) do_reclaim=0; shift ;;
      *) err "unknown flag: $1"; exit 1 ;;
    esac
  done

  if [ -z "$profiles_csv" ] && [ "$do_reclaim" = 1 ]; then
    h1 "reclaiming running kanban workers"
    reclaim_all_running
  fi

  if [ "$keep_supervisor" != 1 ]; then
    h1 "stopping supervisor"
    daemon_stop "steward-supervisor"
  fi
  if [ "$keep_listener" != 1 ]; then
    h1 "stopping chat listener"
    daemon_stop "steward-chat-listener"
  fi
  # Roster + pauser handling. If --profiles narrowed the down, prune ONLY
  # those names from the roster (leave others intact). If down is wholesale
  # (no --profiles), clear the file and stop the pauser daemon.
  if [ -z "$profiles_csv" ]; then
    h1 "stopping inactive-cards pauser"
    daemon_stop "inactive-cards-pauser"
    rm -f "$ROSTER_FILE" 2>/dev/null && dim "cleared $ROSTER_FILE"
  elif [ -f "$ROSTER_FILE" ]; then
    # Build a regex of profiles to drop, then prune
    local drop_re
    drop_re="$(profiles_list "$profiles_csv" | paste -sd'|' -)"
    if [ -n "$drop_re" ]; then
      local tmp="$ROSTER_FILE.tmp"
      grep -vxE "$drop_re" "$ROSTER_FILE" > "$tmp" || true
      mv "$tmp" "$ROSTER_FILE"
      dim "pruned [$profiles_csv] from $ROSTER_FILE → now: $(paste -sd, "$ROSTER_FILE")"
    fi
  fi

  h1 "stopping bots"
  if [ -z "$profiles_csv" ]; then
    # Stop ALL known profiles (flint, mason, gatherer, steward)
    cd "$SCRIPT_DIR" && ./scripts/landfolk-control.sh stop --profiles flint,mason,gatherer,steward 2>&1 \
      | grep -E "stopped|not running|not tracked" | sed 's/^/  /' || true
  else
    while read -r p; do bot_stop_one "$p"; done < <(profiles_list "$profiles_csv")
  fi

  if [ "$stop_gateway" = 1 ]; then
    h1 "stopping hermes gateway"
    if command -v hermes >/dev/null 2>&1 && hermes gateway stop >/dev/null 2>&1; then
      ok "hermes gateway stopped"
    else
      warn "hermes gateway stop failed or gateway was not running"
    fi
  fi

  ok "session down"
}

cmd_restart() {
  local target="${1:-}"
  [ -z "$target" ] && { err "restart needs a target (flint|mason|gatherer|all-bots|listener|supervisor|all)"; exit 1; }
  case "$target" in
    flint|mason|gatherer)
      reclaim_active_for_assignee "$target"
      bot_stop_one "$target"
      sleep 1
      bot_start_one "$target"
      ;;
    all-bots)
      for p in flint mason gatherer steward; do
        reclaim_active_for_assignee "$p"
        bot_stop_one "$p"
      done
      sleep 1
      for p in $(profiles_list "$PROFILES_DEFAULT"); do
        bot_start_one "$p"
      done
      ;;
    listener)
      daemon_stop "steward-chat-listener"
      daemon_start "steward-chat-listener" "$SCRIPT_DIR/scripts/steward-chat-listener.py"
      ;;
    supervisor)
      daemon_stop "steward-supervisor"
      daemon_start "steward-supervisor" "$SCRIPT_DIR/scripts/steward-supervisor.py"
      ;;
    pauser)
      daemon_stop "inactive-cards-pauser"
      ACTIVE_PROFILES_FILE="$ROSTER_FILE" \
        daemon_start "inactive-cards-pauser" "$SCRIPT_DIR/scripts/inactive-cards-pauser.py"
      ;;
    all)
      cmd_down
      sleep 1
      cmd_up
      ;;
    *) err "unknown target: $target"; exit 1 ;;
  esac
}

cmd_status() {
  local want_json=0
  [ "${1:-}" = "--json" ] && want_json=1

  if [ "$want_json" = 1 ]; then
    python3 <<'PYEOF'
import json, subprocess, os, sys
def cap(*c): return subprocess.run(c, capture_output=True, text=True).stdout
bots = {}
for p, port in (('flint',3002),('mason',3003),('gatherer',3001)):
    try:
        import urllib.request
        r = urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
        d = json.loads(r.read())
        bots[p] = {'port': port, 'connected': d.get('connected'), 'pos': d.get('position'), 'holding': d.get('holding'), 'uptime': d.get('uptime_sec')}
    except Exception:
        bots[p] = {'port': port, 'reachable': False}
print(json.dumps({'bots': bots}, indent=2))
PYEOF
    return
  fi

  h1 "MC server (192.168.1.202:25565)"
  nc -z -w 2 192.168.1.202 25565 >/dev/null 2>&1 && ok "reachable" || err "unreachable"

  h1 "bots"
  printf "  %-10s %-6s %-9s %-22s %-14s %s\n" "profile" "port" "viewer" "position" "holding" "uptime"
  for p in flint mason gatherer steward; do
    local info; info="$(bot_health "$p" || true)"
    if [ -z "$info" ]; then
      printf "  %-10s %-6s %-9s %-22s %-14s %s\n" "$p" "${BOT_PORTS[$p]}" ":${VIEWER_PORTS[$p]}" "DOWN" "-" "-"
    else
      local connected pos holding uptime
      connected="$(echo "$info" | sed -E 's/.*connected=([^;]*).*/\1/')"
      pos="$(echo "$info" | sed -E 's/.*pos=([^;]*).*/\1/')"
      holding="$(echo "$info" | sed -E 's/.*holding=([^;]*).*/\1/')"
      uptime="$(echo "$info" | sed -E 's/.*uptime=([^;]*).*/\1/')"
      local conn_mark
      if [ "$connected" = "True" ]; then conn_mark="${C_OK}OK${C_RST}"; else conn_mark="${C_ERR}--${C_RST}"; fi
      printf "  %-10s %-6s %-9s %b %-19s %-14s %ss\n" "$p" "${BOT_PORTS[$p]}" ":${VIEWER_PORTS[$p]}" "$conn_mark" "$pos" "$holding" "$uptime"
    fi
  done

  h1 "daemons"
  for d in steward-chat-listener steward-supervisor inactive-cards-pauser; do
    if daemon_alive "$d"; then
      ok "$d running (pid $(daemon_pid "$d"))"
    else
      dim "$d stopped"
    fi
  done

  h1 "ambient services"
  if pgrep -f "hermes_cli.*gateway" >/dev/null 2>&1; then ok "hermes gateway running"; else warn "hermes gateway NOT running (run: hermes gateway run --replace)"; fi
  if lsof -nP -iTCP:9119 -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then ok "hermes dashboard on :9119"; else dim "hermes dashboard not listening"; fi

  h1 "kanban (landfolk-ops)"
  hermes kanban --board landfolk-ops stats 2>&1 | grep -E "By status|running|blocked|ready|todo|done" | head -8 | sed 's/^/  /'

  h1 "players online"
  ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'list'" 2>&1 | sed 's/^/  /' | head -2
}

cmd_fix() {
  local issue="${1:-}"
  shift || true
  case "$issue" in
    reconnect)
      local bot="${1:-}"; [ -z "$bot" ] && { err "fix reconnect needs a bot name"; exit 1; }
      bot_force_reconnect "$bot"
      ;;
    clean)
      h1 "killing orphan node server.js procs (not associated with landfolk-control)"
      # Find node bots running but NOT tracked by landfolk-control pid files
      local tracked=""
      for f in /tmp/hermescraft/landfolk-control/bot-*.pid; do
        [ -f "$f" ] && tracked="$tracked $(cat "$f")"
      done
      pgrep -af "node server.js" 2>/dev/null | while read -r pid rest; do
        if ! echo "$tracked" | grep -qw "$pid"; then
          kill "$pid" 2>/dev/null && warn "killed orphan node bot pid=$pid"
        fi
      done || true
      # Stale pid files
      for f in /tmp/hermescraft/landfolk-control/*.pid; do
        [ -f "$f" ] || continue
        pid="$(cat "$f")"
        if ! kill -0 "$pid" 2>/dev/null; then
          rm -f "$f" && dim "removed stale pidfile $(basename "$f")"
        fi
      done
      ok "clean done"
      ;;
    tp)
      local bot="${1:-}" x="${2:-}" y="${3:-}" z="${4:-}"
      [ -z "$bot$x$y$z" ] && { err "fix tp needs <bot> <x> <y> <z>"; exit 1; }
      ssh -n ubuntu-host "sudo docker exec minecraft rcon-cli 'tp $bot $x $y $z'" 2>&1 | head -2 | sed 's/^/  /'
      ;;
    unstick)
      local bot="${1:-}"; [ -z "$bot" ] && { err "fix unstick needs a bot name"; exit 1; }
      bot_force_reconnect "$bot"
      sleep 2
      reclaim_active_for_assignee "$bot"
      ok "unstick complete — bot reconnected + active cards reclaimed; gateway will redispatch"
      ;;
    *)
      err "unknown issue: ${issue:-<none>}"
      echo "  valid: reconnect <bot> | clean | tp <bot> <x> <y> <z> | unstick <bot>"
      exit 1
      ;;
  esac
}

cmd_logs() {
  # Allow `logs --help` / `logs -h` without specifying a component.
  if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    sed -n '17,29p' "$0" | sed -E 's/^# ?//'
    return 0
  fi
  # If the first arg is a flag (--foo/-x), default the component to "agents".
  local comp="agents"
  if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
    comp="$1"; shift
  fi
  local lines=20
  local follow=""
  local profiles_csv=""
  local no_bot_logs=0
  local no_color=0
  local quiet=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --tail) lines="$2"; shift 2 ;;
      --follow|-f) follow="-f"; shift ;;
      --profiles) profiles_csv="$2"; shift 2 ;;
      --no-bot-logs) no_bot_logs=1; shift ;;
      --no-color) no_color=1; shift ;;
      --quiet|-q) quiet=1; shift ;;
      -h|--help)
        sed -n '17,29p' "$0" | sed -E 's/^# ?//'
        return 0 ;;
      *) err "unknown flag: $1"; exit 1 ;;
    esac
  done
  case "$comp" in
    agents|"")
      # Default: aggregated live tail across active profiles' newest sessions
      # (landfolk-continuous or kanban-worker, whichever is fresher), folded in
      # with the bot bodies' chat/connect/kick events. Color-coded per player.
      local agg_profiles="${profiles_csv:-$PROFILES_DEFAULT}"
      local agg_args=( --profiles "$agg_profiles" --tail "$lines" )
      [ "$no_bot_logs" = 1 ] && agg_args+=( --no-bot-logs )
      [ "$no_color" = 1 ] && agg_args+=( --no-color )
      [ "$quiet" = 1 ] && agg_args+=( --quiet )
      exec python3 -u "$SCRIPT_DIR/scripts/landfolk-logs-aggregate.py" "${agg_args[@]}"
      ;;
    flint|mason|gatherer|steward) tail $follow -n "$lines" "$LOG_DIR/bot-$comp.log" ;;
    listener) tail $follow -n "$lines" "$LOG_DIR/steward-chat-listener.log" ;;
    supervisor) tail $follow -n "$lines" "$LOG_DIR/steward-supervisor.log" ;;
    pauser) tail $follow -n "$lines" "$LOG_DIR/inactive-cards-pauser.log" ;;
    gateway) tail $follow -n "$lines" "$LOG_DIR/gateway.log" 2>/dev/null || warn "no gateway log file" ;;
    *) err "unknown component: $comp"; exit 1 ;;
  esac
}

cmd_chat() {
  local bot="${1:-}"; shift || true
  [ -z "$bot" ] && { err "chat needs <bot> \"message\""; exit 1; }
  bot_send_chat "$bot" "$*"
}

# ─── Dispatch ──────────────────────────────────────────────────────────────

CMD="${1:-}"; shift || true
case "$CMD" in
  up) cmd_up "$@" ;;
  down) cmd_down "$@" ;;
  restart) cmd_restart "$@" ;;
  status|st) cmd_status "$@" ;;
  fix) cmd_fix "$@" ;;
  logs|log) cmd_logs "$@" ;;
  chat) cmd_chat "$@" ;;
  -h|--help|help|"") usage 0 ;;
  *) err "unknown command: $CMD"; usage 1 ;;
esac
