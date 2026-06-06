#!/usr/bin/env bash
# Run mapcatalog unit tests with periodic elapsed-time heartbeats (for long CI / handover).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="${1:-/tmp/mapcatalog-pytest.log}"
INTERVAL="${MAPCATALOG_WATCH_INTERVAL:-30}"

echo "[$(date -Iseconds)] mapcatalog unit tests → $LOG (heartbeat every ${INTERVAL}s)"

if ! [[ -x "${ROOT}/.venv/bin/pytest" ]]; then
  echo "missing .venv/bin/pytest" >&2
  exit 1
fi

(
  while true; do
    sleep "$INTERVAL"
    if [[ -f "$LOG" ]]; then
      lines=$(wc -l < "$LOG" | tr -d ' ')
      echo "[$(date -Iseconds)] still running… log lines=$lines elapsed=$((SECONDS))s"
    else
      echo "[$(date -Iseconds)] still running… elapsed=$((SECONDS))s (no log yet)"
    fi
  done
) &
WATCH_PID=$!

cleanup() {
  kill "$WATCH_PID" 2>/dev/null || true
}
trap cleanup EXIT

SECONDS=0
set +e
.venv/bin/pytest tests/unit/test_mapcatalog_*.py -m unit -q --tb=short 2>&1 | tee "$LOG"
code=${PIPESTATUS[0]}
set -e

echo "[$(date -Iseconds)] finished exit=$code elapsed=${SECONDS}s"
exit "$code"
