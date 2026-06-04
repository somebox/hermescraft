#!/usr/bin/env bash
# Stop landfolk fleet and clear orphaned bot loops / HTTP listeners.
# macOS /bin/bash 3.2: landfolk stop may not kill children — this is the fix.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORTS="${ESTABLISH_PORTS:-3001 3002 3003 3005}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"

echo "== establish fleet cleanup =="
LOG_SRC="${HERMESCRAFT_LOG_DIR:-/tmp/hermescraft}"
if [[ -d "$LOG_SRC" ]] && [[ -x scripts/snapshot-fleet-logs.sh ]]; then
  echo "== snapshot fleet logs (before stop) =="
  scripts/snapshot-fleet-logs.sh || echo "WARN: snapshot-fleet-logs failed (continuing)" >&2
fi

# Stop the dashboard before the bots so any in-flight poll quiesces
# cleanly. PID file is written by establish-run.sh; if it's missing,
# fall back to a port-based kill so a manually-started dashboard still
# gets cleaned up.
DASH_PID_FILE="$LOG_SRC/dashboard.pid"
if [[ -f "$DASH_PID_FILE" ]]; then
  dash_pid="$(cat "$DASH_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$dash_pid" ]] && kill -0 "$dash_pid" 2>/dev/null; then
    echo "  stop dashboard (pid $dash_pid)"
    kill "$dash_pid" 2>/dev/null || true
    sleep 1
    kill -9 "$dash_pid" 2>/dev/null || true
  fi
  rm -f "$DASH_PID_FILE"
fi
dash_listener="$(lsof -nP -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [[ -n "$dash_listener" ]]; then
  echo "  kill dashboard listener on :$DASHBOARD_PORT (pid $dash_listener)"
  kill -9 "$dash_listener" 2>/dev/null || true
fi

if [[ -x scripts/landfolk ]]; then
  scripts/landfolk stop 2>/dev/null || true
fi

pkill -9 -f 'landfolk:' 2>/dev/null || true

# Phase E follow-up (Phase D postmortem #5): `landfolk stop` and the
# `landfolk:` pkill above don't reach the hermes kanban-task processes
# launched per-card by the gateway dispatcher. Orphans persist into the
# next run and create a pathfinder race (two hermes drive the same bot).
# Kill them by command signature.
pkill -9 -f 'hermes -p .* kanban task' 2>/dev/null || true

for p in $PORTS; do
  pid="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$pid" ]]; then
    echo "  kill listener on :$p (pid $pid)"
    kill -9 "$pid" 2>/dev/null || true
  fi
done

sleep 1
if pgrep -fl 'landfolk:' >/dev/null 2>&1; then
  echo "WARN: landfolk processes still running" >&2
  pgrep -fl 'landfolk:' >&2 || true
else
  echo "  landfolk processes: none"
fi

for p in $PORTS; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 1 "http://127.0.0.1:$p/status" 2>/dev/null || echo 000)"
  echo "  :$p status HTTP $code"
done
