#!/usr/bin/env bash
# Reset proc-nav-lab kanban + dispatcher — no wheat fixture.
set -u
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
BOARD="${BOARD:-proc-nav-lab}"
cd "$(dirname "$0")/.."
log() { printf '[reset-proc-nav] %s\n' "$*"; }

log "kill dispatcher pids"
for pidfile in /tmp/proc-nav-dispatcher-pid /tmp/proc-nav-dispatcher-*.pid; do
  [[ -f "$pidfile" ]] || continue
  pid=$(cat "$pidfile" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && log "killed $pidfile"
  rm -f "$pidfile"
done

hermes kanban boards create "$BOARD" >/dev/null 2>&1 || true

log "archive cards on board=$BOARD"
card_ids=$(hermes kanban --board "$BOARD" list 2>/dev/null | grep -oE 't_[0-9a-f]+' | sort -u || true)
if [[ -n "$card_ids" ]]; then
  while read -r cid; do
    [[ -n "$cid" ]] && hermes kanban --board "$BOARD" archive "$cid" 2>/dev/null || true
  done <<<"$card_ids"
else
  log "board empty"
fi

for prof in navigator planner; do
  mem="$HERMES_HOME/profiles/$prof/memories/MEMORY.md"
  if [[ -f "$mem" ]]; then
    : >"$mem"
    log "zeroed $prof MEMORY.md"
  fi
done

log "done (no proc-lab reset, no wheat fixture)"
