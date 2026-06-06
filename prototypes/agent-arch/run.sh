#!/usr/bin/env bash
# End-to-end runner for the agent-arch prototype.
#
# Boots the mock bot, dispatches the scenario, drives one dispatch tick
# against the proto tenant, and tails the worker log so you can watch a
# card play out.
#
# Usage:
#   ./run.sh scenarios/A-single.txt
#   ./run.sh scenarios/B-chain.txt
#
# Env overrides:
#   PROTO_MOCK_PORT  (default 3091) — must match what setup.sh wrote into
#                                     the profile .env files
#   PROTO_TENANT     (default proto-agent-arch)
#   PROTO_MAX        (default 3) — how many cards `kanban dispatch` claims
#                                  per invocation
#   PROTO_PY         (default .venv/bin/python on the hermescraft repo)
#
# Leaves the mock running after exit unless PROTO_STOP_MOCK=1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$REPO_ROOT/prototypes/agent-arch"

PORT="${PROTO_MOCK_PORT:-3091}"
TENANT="${PROTO_TENANT:-proto-agent-arch}"
MAX="${PROTO_MAX:-3}"
PY="${PROTO_PY:-$REPO_ROOT/.venv/bin/python}"
MOCK_LOG="${PROTO_MOCK_LOG:-/tmp/proto-mock.log}"
MOCK_PID_FILE="${PROTO_MOCK_PID:-/tmp/proto-mock.pid}"

# Phase 0 found `hermes kanban dispatch` is not tenant-scoped, so the
# prototype lives in its own HERMES_HOME. setup.sh defaults to the same
# location; override both with the same env if you want a different one.
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes-proto-agent-arch}"

log() { printf '[run] %s\n' "$*"; }
die() { printf '[run] ERROR: %s\n' "$*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: $0 <scenario-file>"
SCENARIO="$1"
[ -f "$SCENARIO" ] || die "scenario not found: $SCENARIO"

command -v hermes >/dev/null || die "hermes CLI not on PATH"
command -v node >/dev/null || die "node not on PATH"
[ -x "$PY" ] || die "python not at $PY (set PROTO_PY or activate the project venv)"

if [ ! -d "$HERMES_HOME/profiles/pilot-navigator" ]; then
  die "pilot-navigator profile not found in $HERMES_HOME — run ./setup.sh first"
fi

log "HERMES_HOME=$HERMES_HOME"

# ----- boot mock ----------------------------------------------------------

if [ -f "$MOCK_PID_FILE" ] && kill -0 "$(cat "$MOCK_PID_FILE")" 2>/dev/null; then
  log "mock bot already running (pid=$(cat "$MOCK_PID_FILE"), port=$PORT)"
else
  log "starting mock bot on port $PORT"
  PROTO_MOCK_PORT="$PORT" PROTO_MOCK_LOG="$MOCK_LOG" PROTO_MOCK_PID="$MOCK_PID_FILE" \
    node "$HERE/mock-bot.mjs" >/dev/null 2>&1 &
  sleep 0.5
  [ -f "$MOCK_PID_FILE" ] || die "mock bot failed to start"
fi

# Smoke: confirm we can talk to the mock before going further.
if ! curl -sf "http://127.0.0.1:$PORT/status" >/dev/null; then
  die "mock bot not responding on port $PORT"
fi
log "mock bot healthy"

# ----- dispatch the scenario ---------------------------------------------

log "dispatching $SCENARIO (tenant=$TENANT)"
"$PY" "$HERE/dispatch.py" --body-file "$SCENARIO" --tenant "$TENANT"

# ----- run one dispatch tick ---------------------------------------------

log "running 1 dispatch tick (max=$MAX)"
hermes kanban dispatch --tenant "$TENANT" --max "$MAX" || {
  warn_rc=$?
  log "dispatch exited with $warn_rc (may be normal if no ready cards)"
}

# ----- show what landed --------------------------------------------------

log "board snapshot:"
hermes kanban list --tenant "$TENANT" --json 2>/dev/null | head -120 || true

log "mock log (tail):"
tail -20 "$MOCK_LOG" 2>/dev/null || true

if [ "${PROTO_STOP_MOCK:-0}" = "1" ]; then
  log "stopping mock"
  kill "$(cat "$MOCK_PID_FILE")" 2>/dev/null || true
fi

log "done"
