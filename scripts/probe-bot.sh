#!/usr/bin/env bash
# probe-bot.sh — comprehensive read-only diagnostic for one or all landfolk bots.
#
# Probes every HTTP endpoint, compares against rcon ground truth, scans recent
# bot log for known failure patterns, and prints a diagnosis. Pure read-only —
# no force-reconnects, no kills.
#
# Usage:
#   scripts/probe-bot.sh                   # all bots in roster
#   scripts/probe-bot.sh mason              # one bot
#   scripts/probe-bot.sh --json mason       # machine-readable
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_MODELS_JSON="$SCRIPT_DIR/data/agent-models.json"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
RCON_HOST="${RCON_HOST:-ubuntu-host}"
RECENT_S="${RECENT_S:-600}"  # window for "recent" log scan, default 10 min

JSON_OUT=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    -*)     echo "unknown flag: $arg" >&2; exit 1 ;;
    *)      TARGETS+=("$arg") ;;
  esac
done

# Color codes — disabled if not a TTY
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_BAD=''; C_DIM=''; C_BOLD=''; C_RST=''
fi
ok()    { printf '  %s✓%s %s\n' "$C_OK" "$C_RST" "$*"; }
warn()  { printf '  %s⚠%s %s\n' "$C_WARN" "$C_RST" "$*"; }
bad()   { printf '  %s✗%s %s\n' "$C_BAD" "$C_RST" "$*"; }
dim()   { printf '  %s%s%s\n'   "$C_DIM" "$*" "$C_RST"; }

# Resolve port from agent-models.json
port_for() {
  python3 -c "
import json,sys
d=json.load(open('$AGENT_MODELS_JSON'))
for k,v in (d.get('agents') or {}).items():
  if k.lower() == '$1'.lower(): print(v.get('api_port','')); break
" 2>/dev/null
}

# Get all roster bot names (capitalized)
list_targets() {
  if [ "${#TARGETS[@]}" -gt 0 ]; then
    printf '%s\n' "${TARGETS[@]}"
  else
    python3 -c "
import json
d=json.load(open('$AGENT_MODELS_JSON'))
for k in (d.get('agents') or {}).keys(): print(k.lower())
"
  fi
}

probe_one() {
  local name_lower="$1"
  local name; name="$(printf '%s' "$name_lower" | python3 -c "import sys;s=sys.stdin.read().strip();print(s[0].upper()+s[1:])")"
  local port; port="$(port_for "$name_lower")"
  [ -z "$port" ] && { bad "$name: no api_port in agent-models.json"; return; }

  printf '\n%s%s== %s ==%s  (port=%s, name=%s)\n' "$C_BOLD" "$C_OK" "$name" "$C_RST" "$port" "$name"

  # ── 1. HTTP /health ──────────────────────────────────────────────────
  local health
  health="$(curl -sS --max-time 2 "http://127.0.0.1:$port/health" 2>/dev/null)"
  if [ -z "$health" ]; then
    bad "HTTP /health: NO RESPONSE on :$port"
    dim "  (bot process may be alive but not listening, or port differs)"
    return
  fi
  local connected px py pz holding move_rate uptime model api_url last_err
  connected="$(echo "$health" | python3 -c "import json,sys;print((json.load(sys.stdin).get('connected') or False))" 2>/dev/null)"
  px="$(echo "$health" | python3 -c "import json,sys;p=json.load(sys.stdin).get('position') or {};print(p.get('x'))" 2>/dev/null)"
  py="$(echo "$health" | python3 -c "import json,sys;p=json.load(sys.stdin).get('position') or {};print(p.get('y'))" 2>/dev/null)"
  pz="$(echo "$health" | python3 -c "import json,sys;p=json.load(sys.stdin).get('position') or {};print(p.get('z'))" 2>/dev/null)"
  holding="$(echo "$health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('holding'))" 2>/dev/null)"
  move_rate="$(echo "$health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('move_rate'))" 2>/dev/null)"
  uptime="$(echo "$health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('uptime_sec'))" 2>/dev/null)"
  model="$(echo "$health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('model'))" 2>/dev/null)"

  if [ "$connected" = "True" ]; then
    ok "HTTP /health: connected=true uptime=${uptime}s model=$model"
  else
    bad "HTTP /health: connected=$connected (TCP up but bot reports not-connected)"
  fi
  echo "    bot-self pos: ($px, $py, $pz)  holding=$holding  move_rate=$move_rate"

  # ── 2. Position-corruption check (the main thing we're hunting) ─────
  local bot_pos_corrupt=0
  if [ "$px" = "None" ] || [ "$pz" = "None" ] || [ "$px" = "null" ] || [ "$pz" = "null" ]; then
    bad "POSITION CORRUPTION DETECTED — bot self-reports null/None for x or z while connected=$connected"
    bot_pos_corrupt=1
  elif echo "$px$pz" | grep -qi 'nan'; then
    bad "POSITION CORRUPTION DETECTED — NaN in position"
    bot_pos_corrupt=1
  else
    ok "position not corrupted (x,z are real numbers)"
  fi

  # ── 3. Server ground truth via rcon ─────────────────────────────────
  local rcon_pos
  rcon_pos="$(ssh -n -o ConnectTimeout=3 "$RCON_HOST" "sudo docker exec minecraft rcon-cli 'data get entity $name Pos'" 2>/dev/null)"
  if echo "$rcon_pos" | grep -q 'has the following entity data'; then
    local rcx rcy rcz
    # Format: "Mason has the following entity data: [365.50d, 65.0d, -571.6d]"
    # Extract three signed-float-d tokens between [ and ].
    rcx="$(echo "$rcon_pos" | python3 -c "
import re,sys
m=re.search(r'\[(-?[0-9.]+)d,\s*(-?[0-9.]+)d,\s*(-?[0-9.]+)d\]', sys.stdin.read())
if m: print(m.group(1))
")"
    rcy="$(echo "$rcon_pos" | python3 -c "
import re,sys
m=re.search(r'\[(-?[0-9.]+)d,\s*(-?[0-9.]+)d,\s*(-?[0-9.]+)d\]', sys.stdin.read())
if m: print(m.group(2))
")"
    rcz="$(echo "$rcon_pos" | python3 -c "
import re,sys
m=re.search(r'\[(-?[0-9.]+)d,\s*(-?[0-9.]+)d,\s*(-?[0-9.]+)d\]', sys.stdin.read())
if m: print(m.group(3))
")"
    echo "    server pos:    ($rcx, $rcy, $rcz)"
    if [ "$bot_pos_corrupt" = "1" ]; then
      bad "DESYNC: server thinks bot is at ($rcx, $rcy, $rcz) but bot client has null/NaN"
    elif [ -n "$rcx" ] && [ "$px" != "None" ] && [ "$px" != "null" ]; then
      # Compute distance
      local dist
      dist="$(python3 -c "
try:
  dx=float('$px')-float('$rcx');dy=float('$py')-float('$rcy');dz=float('$pz')-float('$rcz')
  print(f'{(dx*dx+dy*dy+dz*dz)**0.5:.2f}')
except Exception: print('?')
")"
      if [ "$dist" = "?" ]; then
        warn "couldn't compute desync"
      elif python3 -c "import sys;sys.exit(0 if float('$dist')<3.0 else 1)"; then
        ok "client/server position agree within ${dist}m"
      else
        warn "client/server position differ by ${dist}m"
      fi
    fi
  else
    dim "rcon ground truth unavailable: $(echo "$rcon_pos" | head -1 | cut -c1-80)"
  fi

  # ── 4. Bot process tree ─────────────────────────────────────────────
  local node_pid loop_pid wd_pid agent_pid
  loop_pid="$(pgrep -f "landfolk:bot-loop:$name" 2>/dev/null | head -1)"
  wd_pid="$(pgrep -f "landfolk:watchdog:$name" 2>/dev/null | head -1)"
  agent_pid="$(pgrep -f "landfolk:agent-loop:$name" 2>/dev/null | head -1)"
  if [ -n "$loop_pid" ]; then
    node_pid="$(pgrep -P "$loop_pid" -f 'node server.js' 2>/dev/null | head -1)"
  fi
  printf '    processes:   '
  [ -n "$loop_pid" ]  && printf 'bot-loop=%s ' "$loop_pid"     || printf 'bot-loop=%s%s%s ' "$C_BAD" 'missing' "$C_RST"
  [ -n "$node_pid" ]  && printf 'node=%s '     "$node_pid"     || printf 'node=%s%s%s '     "$C_BAD" 'missing' "$C_RST"
  [ -n "$wd_pid" ]    && printf 'watchdog=%s ' "$wd_pid"       || printf 'watchdog=%s%s%s ' "$C_BAD" 'missing' "$C_RST"
  [ -n "$agent_pid" ] && printf 'agent=%s '    "$agent_pid"    || printf 'agent=%s%s%s '    "$C_DIM" 'none(kanban-mode)' "$C_RST"
  echo

  # ── 5. Active worker (kanban-driven LLM session) ────────────────────
  local worker_info
  worker_info="$(ps -ax -o pid,etime,command 2>/dev/null | grep -E "hermes -p $name_lower .* work kanban task" | grep -v grep | head -1)"
  if [ -n "$worker_info" ]; then
    local wpid wetime wtid
    wpid="$(echo "$worker_info"  | awk '{print $1}')"
    wetime="$(echo "$worker_info" | awk '{print $2}')"
    wtid="$(echo "$worker_info" | grep -oE 't_[a-z0-9]+' | head -1)"
    ok "kanban worker active: pid=$wpid etime=$wetime task=$wtid"
  else
    dim "kanban worker: none active (bot is idle until a card claims it)"
  fi

  # ── 6. TCP socket to MC server ──────────────────────────────────────
  if [ -n "$node_pid" ]; then
    local tcp
    tcp="$(lsof -nP -p "$node_pid" -iTCP -a -sTCP:ESTABLISHED 2>/dev/null | grep '25565' | head -1)"
    if [ -n "$tcp" ]; then
      ok "TCP to MC server ESTABLISHED ($(echo "$tcp" | awk '{print $9}'))"
    else
      bad "no ESTABLISHED TCP to MC server :25565 — bot's mineflayer socket may be dead"
    fi
  fi

  # ── 7. Current bot-side task (mc task) ──────────────────────────────
  local task_json
  task_json="$(curl -sS --max-time 2 "http://127.0.0.1:$port/task" 2>/dev/null)"
  if [ -n "$task_json" ]; then
    echo "$task_json" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  t=(d.get('data') or {}).get('task') or d.get('task') or {}
  st=t.get('status') or 'idle'
  ac=t.get('action') or 'none'
  el=t.get('elapsed_s')
  err=t.get('error') or ''
  if st in ('running','stuck'):
    print(f'    mc task: {ac} status={st} elapsed={el}s' + (f' error={err[:80]}' if err else ''))
    if st == 'stuck':
      print(f'    ⚠ task is stuck — watchdog should be canceling it')
  else:
    print(f'    mc task: idle (no current action)')
except Exception as e:
  print(f'    mc task: parse error {e}')
"
  fi

  # ── 8. Recent log signals (deaths, reconnects, NaN proxies) ─────────
  local log="$LOG_DIR/bot-${name_lower}.log"
  if [ -f "$log" ]; then
    local since_min=$((RECENT_S / 60))
    local recent
    # Last N lines (rough heuristic — proper window would need date parsing)
    recent="$(tail -200 "$log" 2>/dev/null)"
    local n_deaths n_recon n_nan_proxy n_session_replace n_pos_diag_corrupt n_pos_diag_recover
    n_deaths="$(echo "$recent"          | grep -c 'DIED!')"
    n_recon="$(echo "$recent"           | grep -c 'Reconnecting in')"
    n_nan_proxy="$(echo "$recent"       | grep -cE 'hostile=[^@ ]+@NaN|Pos:null,')"
    n_session_replace="$(echo "$recent" | grep -c 'session replacement already in flight')"
    n_pos_diag_corrupt="$(echo "$recent" | grep -c '\[POS_DIAG\].*CORRUPT')"
    n_pos_diag_recover="$(echo "$recent" | grep -c '\[POS_DIAG\].*RECOVERED')"
    echo "    log signals (last ~200 lines):"
    printf '      deaths=%-2s  reconnects=%-2s  session_replace=%-2s  nan_proxy=%-2s  pos_diag_corrupt=%-2s  pos_diag_recover=%-2s\n' \
      "$n_deaths" "$n_recon" "$n_nan_proxy" "$n_session_replace" "$n_pos_diag_corrupt" "$n_pos_diag_recover"
    # Surface any POS_DIAG event lines
    local diag_lines
    diag_lines="$(echo "$recent" | grep '\[POS_DIAG\]' | tail -5)"
    if [ -n "$diag_lines" ]; then
      echo "    recent POS_DIAG entries:"
      echo "$diag_lines" | sed 's/^/      /'
    fi
  fi

  # ── 9. Quick chat-pipeline sanity check ──────────────────────────────
  local state_json social_n new_chat_n
  state_json="$(curl -sS --max-time 2 "http://127.0.0.1:$port/state" 2>/dev/null)"
  if [ -n "$state_json" ]; then
    social_n="$(echo "$state_json" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  s=(d.get('data') or {}).get('social') or d.get('social') or {}
  print(len(s.get('chatLog') or []))
except: print(0)" 2>/dev/null)"
    new_chat_n="$(echo "$state_json" | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  print(len((d.get('data') or {}).get('new_chat') or d.get('new_chat') or []))
except: print(0)" 2>/dev/null)"
    echo "    chat: total_log=$social_n  unread=$new_chat_n"
  fi
}

# Main
printf '%s%sBot probe%s  (host: %s, log dir: %s)\n' "$C_BOLD" "$C_OK" "$C_RST" "$(hostname -s)" "$LOG_DIR"
list_targets | while read -r tgt; do
  [ -z "$tgt" ] && continue
  probe_one "$tgt"
done
echo
