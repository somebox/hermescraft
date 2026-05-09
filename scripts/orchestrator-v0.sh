#!/usr/bin/env bash
# Experiment 1.3 — Scripted orchestrator for two-bot Minecraft collaboration
#
# Drives Flint (port 3001) and Mason (port 3002) sequentially by writing
# goal-engine entries via the bot HTTP API. Polls inventory to detect
# completion. Pure script, no LLM.
#
# Usage:  bash orchestrator-v0.sh [target_count]
#   target_count — how many dirt blocks each bot must end up holding above their start (default 2)
#
# Exit codes: 0 = success, 1 = setup error, 2 = phase 1 timed out, 3 = phase 2 timed out

set -uo pipefail
TARGET="${1:-2}"
FLINT_API="http://localhost:3001"
MASON_API="http://localhost:3002"
POLL_INTERVAL=10
PHASE_TIMEOUT=600  # 10 min per phase
LOG=/tmp/hermescraft-exp1/orchestrator-v0.log

ts() { date '+%H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

dirt_count() {
  local api="$1"
  curl -sf "$api/inventory" 2>/dev/null \
    | python3 -c "
import json,sys
d = json.load(sys.stdin).get('data', {})
total = 0
# Two response shapes: empty -> {items: []}; populated -> {categories: {blocks: [...], ...}}
if 'categories' in d:
    for cat in d['categories'].values():
        for it in cat:
            if it.get('name') == 'dirt':
                total += it.get('count', 0)
elif 'items' in d and isinstance(d['items'], list):
    for it in d['items']:
        if it.get('name') == 'dirt':
            total += it.get('count', 0)
print(total)
" 2>/dev/null || echo "0"
}

inject_dirt_goal() {
  local api="$1"
  local target="$2"
  log "  → injecting goal exp_collect_dirt (target_min=$target) into $api"
  curl -sf -X POST "$api/goals" \
    -H 'Content-Type: application/json' \
    -d "{\"goal\":{\"id\":\"exp_collect_dirt\",\"enabled\":true,\"metric\":\"dirt_total\",\"target_min\":$target,\"target_ok\":$((target+1)),\"priority\":250,\"strategies_available\":[\"collect\"]}}" \
    2>&1 | head -c 200
  echo
}

remove_goal() {
  local api="$1"
  log "  → disabling goal exp_collect_dirt on $api"
  curl -sf -X POST "$api/goals/update" \
    -H 'Content-Type: application/json' \
    -d '{"id":"exp_collect_dirt","enabled":false,"priority":0}' \
    2>&1 | head -c 100
  echo
}

# ── start
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
log "=== experiment 1.3 orchestrator-v0 ==="
log "target dirt count per bot: $TARGET"

# verify both bots reachable
for api in "$FLINT_API" "$MASON_API"; do
  curl -sf "$api/health" >/dev/null || { log "ERR: $api unreachable"; exit 1; }
done
log "both bots reachable"

FLINT_START=$(dirt_count "$FLINT_API")
MASON_START=$(dirt_count "$MASON_API")
FLINT_TARGET=$((FLINT_START + TARGET))
MASON_TARGET=$((MASON_START + TARGET))
log "Flint dirt start: $FLINT_START → target $FLINT_TARGET"
log "Mason dirt start: $MASON_START → target $MASON_TARGET"

# ── Phase 1: Flint
log "--- Phase 1: Flint mines $TARGET dirt ---"
inject_dirt_goal "$FLINT_API" "$FLINT_TARGET"

T0=$SECONDS
while true; do
  cur=$(dirt_count "$FLINT_API")
  log "  Flint dirt: $cur / $FLINT_TARGET (elapsed ${SECONDS}s)"
  if [ "$cur" -ge "$FLINT_TARGET" ]; then
    log "Flint complete!"
    break
  fi
  if (( SECONDS - T0 > PHASE_TIMEOUT )); then
    log "TIMEOUT phase 1"
    remove_goal "$FLINT_API"
    exit 2
  fi
  sleep "$POLL_INTERVAL"
done
remove_goal "$FLINT_API"

# ── Phase 2: Mason
log "--- Phase 2: Mason mines $TARGET dirt ---"
inject_dirt_goal "$MASON_API" "$MASON_TARGET"

T0=$SECONDS
while true; do
  cur=$(dirt_count "$MASON_API")
  log "  Mason dirt: $cur / $MASON_TARGET (elapsed ${SECONDS}s)"
  if [ "$cur" -ge "$MASON_TARGET" ]; then
    log "Mason complete!"
    break
  fi
  if (( SECONDS - T0 > PHASE_TIMEOUT )); then
    log "TIMEOUT phase 2"
    remove_goal "$MASON_API"
    exit 3
  fi
  sleep "$POLL_INTERVAL"
done
remove_goal "$MASON_API"

log "=== both phases complete ==="
exit 0
