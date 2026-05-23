#!/usr/bin/env bash
# Stop bot(s) — disconnect from MC and kill associated agents/pollers.
#
# Hermes runs are a layered stack of long-lived processes:
#   1. mineflayer bots (node server.js)  — connected to the MC server.
#                                          Started by run-steve.sh /
#                                          run-tester-bot.sh.
#   2. bash wrappers (run-*-bot.sh)      — parents of (1).
#   3. hermes chat agents (python)       — talk to (1) over HTTP. Started
#                                          by run-landfolk-agent.sh, which
#                                          in turn is started by exp.sh.
#   4. exp.sh poller                     — writes positions.jsonl every 30s.
#
# `exp.sh stop` only stops (3) + (4). Re-running run-steve.sh restarts (1+2)
# but doesn't help if you just want to fully halt without restarting.
#
# Usage:
#   scripts/stop-bots.sh Steve           # stop Steve only (leave Tester alone)
#   scripts/stop-bots.sh Tester          # stop Tester only (leave Steve alone)
#   scripts/stop-bots.sh Gatherer        # stop Gatherer only
#   scripts/stop-bots.sh --all           # stop ALL bots (legacy behaviour)
#   scripts/stop-bots.sh                 # error — require explicit target
#
# Add --quiet to suppress all but warnings.
#
# Why bot-targeted: the expedition launcher (exp.sh start) calls
# stop-bots to clean up the PREVIOUS Steve run. If Tester is mid-run
# in tests/functional/ at the time, the legacy `stop-bots.sh` with no
# args would kill it too and cascade-fail the test suite.
set -uo pipefail

QUIET=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --all|all) TARGET="all" ;;
    Steve|steve) TARGET="steve" ;;
    Tester|tester) TARGET="tester" ;;
    Gatherer|gatherer) TARGET="gatherer" ;;
    -h|--help)
      sed -n '1,28p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown arg '$arg' (expected Steve|Tester|Gatherer|--all|--quiet)" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "ERROR: stop-bots requires a target. Run with Steve | Tester | Gatherer | --all." >&2
  echo "       Add --quiet to suppress non-warning output." >&2
  exit 2
fi

log()  { [[ $QUIET == 0 ]] && echo "$@"; return 0; }
warn() { echo "$@" >&2; }

# ── 1. Per-bot wrapper patterns + ports ──────────────────────────────
# Each bot lives in its own (wrapper, API port, viewer port) tuple.
# This table is the SINGLE source of truth — `--all` iterates it, and
# named-target mode picks a single row.
declare -A WRAPPER PORT_API PORT_VIEWER
WRAPPER[steve]='run-steve-bot.sh'
PORT_API[steve]=3001
PORT_VIEWER[steve]=4001
WRAPPER[tester]='run-tester-bot.sh'
PORT_API[tester]=3004
PORT_VIEWER[tester]=4004
WRAPPER[gatherer]='run-gatherer-bot.sh'
PORT_API[gatherer]=3001
PORT_VIEWER[gatherer]=4001

if [[ "$TARGET" == "all" ]]; then
  TARGETS=(steve tester gatherer)
else
  TARGETS=("$TARGET")
fi

# ── 2. Stop the expedition agent + poller — Steve only ───────────────
# Only Steve runs expeditions. Tester/Gatherer have no hermes agent.
# Whether or not the symlink exists, exp.sh stop is safe (idempotent).
if [[ " ${TARGETS[*]} " == *" steve "* ]]; then
  if [[ -L /tmp/hermescraft/runs/current ]]; then
    log "[stop-bots] active expedition found — running exp.sh stop"
    "$(dirname "$0")/exp.sh" stop || true
  else
    log "[stop-bots] no active expedition"
  fi

  # Force-kill any surviving hermes chat agents (Steve-only — Tester
  # doesn't run hermes agents).
  if pgrep -f '/hermes chat --yolo' >/dev/null 2>&1; then
    log "[stop-bots] hermes chat agent survivors — SIGKILL"
    pkill -9 -f '/hermes chat --yolo' 2>/dev/null || true
  fi
  if pgrep -f 'run-landfolk-agent.sh' >/dev/null 2>&1; then
    pkill -9 -f 'run-landfolk-agent.sh' 2>/dev/null || true
  fi
fi

# ── 3. Stop bot wrappers ─────────────────────────────────────────────
# Each bot is `bash run-*-bot.sh PORT` → `node server.js` child. SIGTERM
# the wrapper; the child inherits and exits cleanly (mineflayer sends
# a proper disconnect packet). Fall back to SIGKILL if needed.
for name in "${TARGETS[@]}"; do
  pattern="${WRAPPER[$name]}"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    log "[stop-bots] stopping $pattern"
    pkill -f "$pattern" 2>/dev/null || true
  fi
done
sleep 2

# ── 4. Force-kill any survivor node server.js processes on this bot's
#       ports. Other bots' ports are LEFT ALONE (the whole point of the
#       targeted mode). For Steve+Gatherer this means we may not free
#       port 3001 if Gatherer is the one holding it — that's correct;
#       killing it would defeat the targeted semantics.
for name in "${TARGETS[@]}"; do
  api_port="${PORT_API[$name]}"
  view_port="${PORT_VIEWER[$name]}"
  # API port: only kill if the process matches THIS bot's wrapper (or
  # is the node child). For --all, we don't bother with that check.
  pid=$(lsof -ti tcp:"$api_port" 2>/dev/null | head -1)
  if [[ -n "$pid" ]]; then
    if [[ "$TARGET" == "all" ]]; then
      log "[stop-bots] port $api_port still held by pid=$pid — SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    else
      # Targeted mode: verify the pid is OUR bot before killing.
      # The wrapper is the grandparent of node; check ppid chain.
      pid_cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
      # node server.js has MC_USERNAME=$name in its env, but env isn't
      # in argv. The safest check: look up the wrapper pid and see if
      # this node is its descendant.
      wrapper_pid=$(pgrep -f "${WRAPPER[$name]}" 2>/dev/null | head -1)
      if [[ -n "$wrapper_pid" ]]; then
        # Walk up from node pid to see if wrapper is an ancestor.
        cur="$pid"
        is_ours=0
        for _ in 1 2 3 4 5; do
          ppid=$(ps -p "$cur" -o ppid= 2>/dev/null | tr -d ' ')
          [[ -z "$ppid" || "$ppid" == "1" ]] && break
          if [[ "$ppid" == "$wrapper_pid" ]]; then is_ours=1; break; fi
          cur="$ppid"
        done
        if [[ $is_ours == 1 ]]; then
          log "[stop-bots] port $api_port (pid=$pid) is $name's — SIGKILL"
          kill -9 "$pid" 2>/dev/null || true
        else
          log "[stop-bots] port $api_port held by pid=$pid (not $name) — leaving alone"
        fi
      else
        # No wrapper for $name running — port is held by something else.
        log "[stop-bots] port $api_port held by pid=$pid but no $name wrapper — leaving alone"
      fi
    fi
  fi
  # Viewer port: same logic. For viewer ports the child is the same
  # node process so the ancestry check above applies. Simpler: kill
  # only when --all OR when the api-port kill happened (we already
  # established the wrapper was ours).
  if [[ "$TARGET" == "all" ]]; then
    pid=$(lsof -ti tcp:"$view_port" 2>/dev/null | head -1)
    if [[ -n "$pid" ]]; then
      log "[stop-bots] viewer port $view_port still held by pid=$pid — SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
done

# ── 5. Summary — only count survivors for the targets we tried to stop.
sleep 1
# Build the pattern to scan from the actual targeted wrappers.
PATTERN_PARTS=()
for name in "${TARGETS[@]}"; do PATTERN_PARTS+=("${WRAPPER[$name]}"); done
if [[ " ${TARGETS[*]} " == *" steve "* ]]; then
  PATTERN_PARTS+=("/hermes chat --yolo" "run-landfolk-agent.sh")
fi
PATTERN="$(IFS='|'; echo "${PATTERN_PARTS[*]}")"
sleep 1
survivors=$(pgrep -lf "$PATTERN" 2>/dev/null || true)
if [[ -z "$survivors" ]]; then
  log "[stop-bots] target=$TARGET — all targeted bots and agents stopped."
else
  warn "[stop-bots] WARNING — survivors for target=$TARGET:"
  printf '%s\n' "$survivors" | sed 's/^/  /'
  exit 1
fi
