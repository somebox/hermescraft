#!/usr/bin/env bash
# proc-nav-tail.sh — one-pane live tail for a trial run (proc-nav OR genesis-v2).
#
# Multiplexes (each line prefixed by source + color):
#   [disp]      dispatcher tick log (proc-nav) / gateway log (genesis-v2)
#   [mox/pip/zee] Mineflayer body HTTP/MC chat (the active bots)
#   [card:TID]  per-card hermes log (auto-discovered from the LIVE board only)
#   [hermes]    proto-logs-follow.py: ACTIVE AGENTS' state.db reasoning + tool calls
#   [lease]     which body each agent currently holds (bot <- profile, TTL) — on change
#
# Defaults to BOARD-aware behaviour: BOARD=genesis-v2 follows the colony-* agents +
# the mox/pip/zee body pool; otherwise the proc-nav roster. Agent REASONING is shown
# BY DEFAULT (use --no-reasoning to hide).
#
# NOTE: LIVE `tail -F`, scoped to the CURRENT run. Card ids come from the live board
# (reinit each run), NOT from globbing the durable board log dir (1000+ stale t_*.log).
# Separate from the genesis ARCHIVAL scoping in capture_run_artifacts (windowed
# actions-*.jsonl + ended_at): that's the post-run record; this is live activity.
#
# Usage:
#   BOARD=genesis-v2 scripts/proc-nav-tail.sh   # colony agents + mox/pip/zee + reasoning + lease
#   scripts/proc-nav-tail.sh --no-reasoning     # hide reasoning blocks
#   scripts/proc-nav-tail.sh --no-hermes        # skip the agent-reasoning stream
#   scripts/proc-nav-tail.sh --no-cards         # skip per-card log discovery
#   scripts/proc-nav-tail.sh --no-lease         # skip the bot-lease view
#   scripts/proc-nav-tail.sh --tail 200         # backfill last N from each agent
#
# Env:
#   RUN_ID       Trial id; auto-read from /tmp/proc-nav-run-id if unset
#   BOARD        Default: proc-nav-lab (set genesis-v2 for colony runs)
#   HERMES_HOME  Default: ~/.hermes
#   PROFILES     Comma-list to follow (overrides the board-derived default)
#
# Ctrl-C cleanly stops every child tail.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
BOARD="${BOARD:-proc-nav-lab}"
# Board-aware defaults (env PROFILES still wins). Genesis-v2 = colony-* agents +
# the mox/pip/zee body pool; proc-nav = its own roster.
if [[ "$BOARD" == genesis* ]]; then
  GENESIS=1
  PROFILES="${PROFILES:-colony-planner,colony-overseer,colony-scout,colony-gatherer,colony-builder,colony-farmer,colony-miner,colony-road}"
else
  GENESIS=0
  PROFILES="${PROFILES:-navigator,planner,builder,navigator-pip,builder-mox,engineer,overseer}"
fi
WITH_REASONING="--reasoning"   # active-agent reasoning ON by default (--no-reasoning hides it)
WITH_HERMES=1
WITH_CARDS=1
WITH_LEASE=1
TAIL_N=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reasoning)    WITH_REASONING="--reasoning"; shift ;;
    --no-reasoning) WITH_REASONING=""; shift ;;
    --no-hermes)    WITH_HERMES=0; shift ;;
    --no-cards)     WITH_CARDS=0; shift ;;
    --no-lease)     WITH_LEASE=0; shift ;;
    --tail)         TAIL_N="$2"; shift 2 ;;
    --profiles)     PROFILES="$2"; shift 2 ;;
    -h|--help)      sed -n '2,34p' "$0"; exit 0 ;;
    *)              echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

RUN_ID="${RUN_ID:-$(cat /tmp/proc-nav-run-id 2>/dev/null || true)}"
if [[ -z "$RUN_ID" ]]; then
  echo "[proc-nav-tail] WARN: no RUN_ID — dispatcher log path may be wrong" >&2
fi

# ── colors (TTY only) ─────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_DISP=$'\033[38;5;75m'    # blue
  C_MOX=$'\033[38;5;221m'    # gold
  C_PIP=$'\033[38;5;114m'    # green
  C_ZEE=$'\033[38;5;209m'    # salmon
  C_CARD=$'\033[38;5;180m'   # tan
  C_HERMES=$'\033[38;5;141m' # purple
  C_LEASE=$'\033[1;38;5;45m' # bright cyan
  C_META=$'\033[2;38;5;244m' # dim grey
  RST=$'\033[0m'
else
  C_DISP=""; C_MOX=""; C_PIP=""; C_ZEE=""; C_CARD=""; C_HERMES=""; C_LEASE=""; C_META=""; RST=""
fi

prefix_tail() {
  # $1 label, $2 color, $3 file
  local label="$1" color="$2" file="$3"
  if [[ ! -f "$file" ]]; then
    return
  fi
  tail -F "$file" 2>/dev/null | sed -u "s|^|${color}[${label}]${RST} |" &
  CHILD_PIDS+=("$!")
}

declare -a CHILD_PIDS=()

cleanup() {
  # Disable re-entry. Second Ctrl-C during cleanup shouldn't recurse.
  trap '' INT TERM EXIT
  echo "${C_META}[proc-nav-tail] stopping ${#CHILD_PIDS[@]} tracked children${RST}" >&2

  # Strategy: SIGKILL everything we spawned, no graceful TERM phase.
  # Reasons:
  #   - tail / sed exit cleanly on either signal; KILL is no worse.
  #   - proto-logs-follow.py only installs a KeyboardInterrupt (SIGINT)
  #     handler — on SIGTERM the Python default action runs, but we can't
  #     count on it returning fast enough.
  #   - The previous recursive pgrep walker hot-looped on macOS in the
  #     SIGTERM-then-wait phase (sampling showed bash spending ~99% of
  #     cleanup time inside read_comsub waiting on pgrep forks).
  # Children spawned inside discover_cards' subshell never made it into
  # CHILD_PIDS (the += there mutates the SUBSHELL's local copy, not the
  # script's), so we ALSO sweep direct children via `pkill -P $$`. Any
  # grandchildren left orphan get reaped by launchd / init.
  for pid in "${CHILD_PIDS[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  pkill -KILL -P $$ 2>/dev/null || true

  echo "${C_META}[proc-nav-tail] done${RST}" >&2
  exit 0
}
trap cleanup INT TERM EXIT

# ── 1. dispatcher / gateway log ──────────────────────────────────────
# Genesis-v2 dispatch runs through the hermes gateway (its log shows the
# dispatcher ticks: spawned/reclaimed/crashed/promoted). proc-nav uses a
# per-run dispatcher log under /tmp.
DISPATCHER_LOG=""
_disp_candidates=()
[[ "$GENESIS" -eq 1 ]] && _disp_candidates+=("$HERMES_HOME/logs/gateway.log")
_disp_candidates+=( \
  "/tmp/proc-nav-dispatcher-${RUN_ID}.log" \
  "$(ls -t /tmp/proc-nav-dispatcher-*.log 2>/dev/null | head -1)" \
  "$(ls -t /tmp/wheat-dispatcher-*.log 2>/dev/null | head -1)")
for c in "${_disp_candidates[@]}"; do
  [[ -n "$c" && -f "$c" ]] && { DISPATCHER_LOG="$c"; break; }
done
if [[ -n "$DISPATCHER_LOG" ]]; then
  echo "${C_META}[proc-nav-tail] dispatcher: $DISPATCHER_LOG${RST}" >&2
  prefix_tail "disp" "$C_DISP" "$DISPATCHER_LOG"
else
  echo "${C_META}[proc-nav-tail] no dispatcher log found${RST}" >&2
fi

# ── 2. bot (body) HTTP logs — the active bots ────────────────────────
# Genesis bodies log to /tmp/<name>-bot.log (genesis-v2.sh ensure_body); the
# proc-nav lab uses /tmp/hermescraft/bot-<name>.log. The genesis pool is mox/pip/zee.
if [[ "$GENESIS" -eq 1 ]]; then BOT_NAMES=(mox pip zee); else BOT_NAMES=(mox pip); fi
for bot in "${BOT_NAMES[@]}"; do
  if [[ "$GENESIS" -eq 1 ]]; then log="/tmp/${bot}-bot.log"; else log="/tmp/hermescraft/bot-${bot}.log"; fi
  if [[ -f "$log" ]]; then
    color="$C_MOX"
    [[ "$bot" == "pip" ]] && color="$C_PIP"
    [[ "$bot" == "zee" ]] && color="$C_ZEE"
    echo "${C_META}[proc-nav-tail] $bot bot log: $log${RST}" >&2
    prefix_tail "$bot" "$color" "$log"
  else
    echo "${C_META}[proc-nav-tail] no $bot bot log (skip)${RST}" >&2
  fi
done

# ── 3. per-card hermes logs (auto-discovered) ────────────────────────
# Cards land under ~/.hermes/kanban/boards/<board>/logs/t_<id>.log when the
# dispatcher spawns a worker. That dir is DURABLE across runs (1000+ stale t_*.log
# accumulate), so we must NOT glob it — globbing would tail every prior-run card at
# startup. Instead derive card ids from the LIVE board (reinit each run → current run
# only), re-queried every 5s so cards created later in this run are picked up. Done
# cards' tails terminate naturally once the file stops growing.
if [[ "$WITH_CARDS" -eq 1 ]]; then
  CARDS_DIR="$HERMES_HOME/kanban/boards/$BOARD/logs"
  if [[ -d "$CARDS_DIR" ]]; then
    discover_cards() {
      declare -A seen
      while true; do
        # Run-scope: only ids on the live board, NOT every t_*.log on disk.
        while IFS= read -r tid; do
          [[ -n "$tid" ]] || continue
          local f="$CARDS_DIR/$tid.log"
          [[ -f "$f" ]] || continue
          if [[ -z "${seen[$tid]:-}" ]]; then
            tail -F "$f" 2>/dev/null \
              | sed -u "s|^|${C_CARD}[card:${tid:0:10}]${RST} |" &
            CHILD_PIDS+=("$!")
            seen[$tid]=1
          fi
        done < <(hermes kanban --board "$BOARD" list --json 2>/dev/null \
                 | python3 -c 'import sys,json
d=json.load(sys.stdin); ts=d if isinstance(d,list) else d.get("tasks",[])
print("\n".join(t["id"] for t in ts if t.get("id")))' 2>/dev/null)
        sleep 5
      done
    }
    discover_cards &
    CHILD_PIDS+=("$!")
    echo "${C_META}[proc-nav-tail] card logs: $BOARD board (live, run-scoped)${RST}" >&2
  else
    echo "${C_META}[proc-nav-tail] no card-logs dir (skip)${RST}" >&2
  fi
fi

# ── 4. hermes profile state.db reasoning + tool calls ────────────────
if [[ "$WITH_HERMES" -eq 1 ]]; then
  if [[ -x "$REPO_ROOT/scripts/proto-logs-follow.py" ]]; then
    echo "${C_META}[proc-nav-tail] hermes profiles: $PROFILES${RST}" >&2
    args=(--profiles "$PROFILES")
    [[ -n "$WITH_REASONING" ]] && args+=("$WITH_REASONING")
    [[ "$TAIL_N" -gt 0 ]] && args+=(--tail "$TAIL_N")
    "$REPO_ROOT/scripts/proto-logs-follow.py" "${args[@]}" \
      2>/dev/null | sed -u "s|^|${C_HERMES}[hermes]${RST} |" &
    CHILD_PIDS+=("$!")
  else
    echo "${C_META}[proc-nav-tail] proto-logs-follow.py not executable (skip)${RST}" >&2
  fi
fi

# ── 5. live lease view: which body each active agent holds ───────────
# Answers "which bot is involved in this card/command": leases live in
# ~/.hermes/bot-leases.db (bot <- profile, with a TTL). A worker's `mc bot checkout`
# binds a body; this prints the bot<-profile map (only when it changes) so you can
# correlate an agent's reasoning ([hermes]) and a card ([card:TID]) with the body
# ([mox]/[pip]/[zee]) it's actually driving.
if [[ "$WITH_LEASE" -eq 1 ]]; then
  LEASE_DB="$HERMES_HOME/bot-leases.db"
  if [[ -f "$LEASE_DB" ]] && command -v sqlite3 >/dev/null 2>&1; then
    lease_snapshot() {
      local last=""
      while true; do
        local now_ms=$(($(date +%s) * 1000)) snap
        snap="$(sqlite3 "$LEASE_DB" \
          "SELECT bot || '<-' || IFNULL(profile,'?') || '(' || CAST((expires_at_ms-$now_ms)/1000 AS INT) || 's)' \
           FROM bot_leases WHERE expires_at_ms > $now_ms ORDER BY bot;" 2>/dev/null | paste -sd' ' -)"
        [[ -z "$snap" ]] && snap="(no active leases)"
        if [[ "$snap" != "$last" ]]; then
          echo "${C_LEASE}[lease]${RST} $snap"
          last="$snap"
        fi
        sleep 5
      done
    }
    lease_snapshot &
    CHILD_PIDS+=("$!")
    echo "${C_META}[proc-nav-tail] lease view: $LEASE_DB${RST}" >&2
  else
    echo "${C_META}[proc-nav-tail] no lease db / sqlite3 (skip lease view)${RST}" >&2
  fi
fi

echo "${C_META}[proc-nav-tail] streaming — Ctrl-C to stop${RST}" >&2
wait
