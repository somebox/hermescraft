#!/usr/bin/env bash
# Copy live fleet logs from /tmp/hermescraft into a postmortem directory.
# Run at fleet stop so mc-*.log continuity gaps (respawn) are preserved.
#
# Usage:
#   scripts/snapshot-fleet-logs.sh [DEST_DIR]
#   RUN_ID=phase11 scripts/snapshot-fleet-logs.sh   # suffix dest when no arg
# Default DEST: data/postmortems/establish-YYYY-MM-DDTHHMMSS-fleet-logs
#   (or establish-YYYY-MM-DD-<RUN_ID>-fleet-logs when RUN_ID is set)

set -euo pipefail

SRC="${HERMESCRAFT_LOG_DIR:-/tmp/hermescraft}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${1:-}" ]; then
  DEST="$1"
elif [ -n "${RUN_ID:-}" ]; then
  DEST="${REPO_ROOT}/data/postmortems/establish-$(date +%Y-%m-%d)-${RUN_ID}-fleet-logs"
else
  DEST="${REPO_ROOT}/data/postmortems/establish-$(date +%Y-%m-%dT%H%M%S)-fleet-logs"
fi

if [ ! -d "$SRC" ]; then
  echo "snapshot-fleet-logs: missing source $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
echo "== snapshot fleet logs: $SRC -> $DEST =="

for pattern in \
  mc-*.log agent-*.log progress-*.log nav-*.jsonl bot-*.log \
  hermes-*.log watchdog-*.log dispatcher.log gateway.log; do
  shopt -s nullglob
  for f in "$SRC"/$pattern; do
    cp -a "$f" "$DEST/"
    echo "  $(basename "$f")"
  done
done

if [ -d "$SRC/sessions" ]; then
  cp -a "$SRC/sessions" "$DEST/"
  echo "  sessions/"
fi

echo "done: $(wc -l "$DEST"/*.log 2>/dev/null | tail -1 || echo 'no .log files')"
