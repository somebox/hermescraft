#!/usr/bin/env bash
# Stop landfolk fleet and clear orphaned bot loops / HTTP listeners.
# macOS /bin/bash 3.2: landfolk stop may not kill children — this is the fix.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORTS="${ESTABLISH_PORTS:-3001 3002 3003 3005}"

echo "== establish fleet cleanup =="
LOG_SRC="${HERMESCRAFT_LOG_DIR:-/tmp/hermescraft}"
if [[ -d "$LOG_SRC" ]] && [[ -x scripts/snapshot-fleet-logs.sh ]]; then
  echo "== snapshot fleet logs (before stop) =="
  scripts/snapshot-fleet-logs.sh || echo "WARN: snapshot-fleet-logs failed (continuing)" >&2
fi
if [[ -x scripts/landfolk ]]; then
  scripts/landfolk stop 2>/dev/null || true
fi

pkill -9 -f 'landfolk:' 2>/dev/null || true

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
