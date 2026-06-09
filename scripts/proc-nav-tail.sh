#!/usr/bin/env bash
# proc-nav-tail.sh — one-pane tail for the proc-nav trial.
#
# Multiplexes (each line prefixed by source + color):
#   [disp]      proc-nav dispatcher tick log
#   [mox]       Mineflayer bot-mox HTTP/MC chat (port 3007)
#   [pip]       Mineflayer bot-pip HTTP/MC chat (port 3005)  (when running)
#   [card:TID]  per-card hermes log (auto-discovered for cards in `running`)
#   [hermes]    proto-logs-follow.py: planner/navigator/builder/* state.db
#               reasoning + tool calls + tool responses
#
# Usage:
#   scripts/proc-nav-tail.sh                # default profiles, no reasoning
#   scripts/proc-nav-tail.sh --reasoning    # include hidden reasoning blocks
#   scripts/proc-nav-tail.sh --no-hermes    # skip the proto-logs-follow stream
#   scripts/proc-nav-tail.sh --no-cards     # skip per-card log discovery
#   scripts/proc-nav-tail.sh --tail 200     # backfill last N from each hermes profile
#
# Env:
#   RUN_ID       Trial id; auto-read from /tmp/proc-nav-run-id if unset
#   BOARD        Default: proc-nav-lab
#   HERMES_HOME  Default: ~/.hermes
#   PROFILES     Comma-list to follow. Default covers single + dual-bot roles:
#                navigator,planner,builder,navigator-pip,builder-mox,engineer,overseer
#
# Ctrl-C cleanly stops every child tail.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
BOARD="${BOARD:-proc-nav-lab}"
PROFILES="${PROFILES:-navigator,planner,builder,navigator-pip,builder-mox,engineer,overseer}"
WITH_REASONING=""
WITH_HERMES=1
WITH_CARDS=1
TAIL_N=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reasoning)    WITH_REASONING="--reasoning"; shift ;;
    --no-hermes)    WITH_HERMES=0; shift ;;
    --no-cards)     WITH_CARDS=0; shift ;;
    --tail)         TAIL_N="$2"; shift 2 ;;
    --profiles)     PROFILES="$2"; shift 2 ;;
    -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
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
  C_CARD=$'\033[38;5;180m'   # tan
  C_HERMES=$'\033[38;5;141m' # purple
  C_META=$'\033[2;38;5;244m' # dim grey
  RST=$'\033[0m'
else
  C_DISP=""; C_MOX=""; C_PIP=""; C_CARD=""; C_HERMES=""; C_META=""; RST=""
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

# ── 1. dispatcher log ────────────────────────────────────────────────
DISPATCHER_LOG=""
for c in \
  "/tmp/proc-nav-dispatcher-${RUN_ID}.log" \
  "$(ls -t /tmp/proc-nav-dispatcher-*.log 2>/dev/null | head -1)" \
  "$(ls -t /tmp/wheat-dispatcher-*.log 2>/dev/null | head -1)"; do
  [[ -n "$c" && -f "$c" ]] && { DISPATCHER_LOG="$c"; break; }
done
if [[ -n "$DISPATCHER_LOG" ]]; then
  echo "${C_META}[proc-nav-tail] dispatcher: $DISPATCHER_LOG${RST}" >&2
  prefix_tail "disp" "$C_DISP" "$DISPATCHER_LOG"
else
  echo "${C_META}[proc-nav-tail] no dispatcher log found${RST}" >&2
fi

# ── 2. bot HTTP logs ─────────────────────────────────────────────────
for bot in mox pip; do
  log="/tmp/hermescraft/bot-${bot}.log"
  if [[ -f "$log" ]]; then
    color="$C_MOX"
    [[ "$bot" == "pip" ]] && color="$C_PIP"
    echo "${C_META}[proc-nav-tail] $bot bot log: $log${RST}" >&2
    prefix_tail "$bot" "$color" "$log"
  else
    echo "${C_META}[proc-nav-tail] no $bot bot log (skip)${RST}" >&2
  fi
done

# ── 3. per-card hermes logs (auto-discovered) ────────────────────────
# Cards land under ~/.hermes/kanban/boards/<board>/logs/t_<id>.log when the
# dispatcher spawns a worker. We discover & tail every card on the board
# (running OR done) — done cards' tails terminate naturally once the file
# stops growing.
if [[ "$WITH_CARDS" -eq 1 ]]; then
  CARDS_DIR="$HERMES_HOME/kanban/boards/$BOARD/logs"
  if [[ -d "$CARDS_DIR" ]]; then
    discover_cards() {
      declare -A seen
      while true; do
        for f in "$CARDS_DIR"/t_*.log; do
          [[ -f "$f" ]] || continue
          local tid; tid="$(basename "$f" .log)"
          if [[ -z "${seen[$tid]:-}" ]]; then
            tail -F "$f" 2>/dev/null \
              | sed -u "s|^|${C_CARD}[card:${tid:0:10}]${RST} |" &
            CHILD_PIDS+=("$!")
            seen[$tid]=1
          fi
        done
        sleep 5
      done
    }
    discover_cards &
    CHILD_PIDS+=("$!")
    echo "${C_META}[proc-nav-tail] card logs: $CARDS_DIR (live discovery)${RST}" >&2
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

echo "${C_META}[proc-nav-tail] streaming — Ctrl-C to stop${RST}" >&2
wait
