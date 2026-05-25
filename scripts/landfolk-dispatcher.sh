#!/usr/bin/env bash
# landfolk-dispatcher.sh — out-of-process kanban dispatcher loop.
#
# Why this exists
# ---------------
# The gateway-embedded dispatcher (`kanban.dispatch_in_gateway: true`) has
# wedged silently 3+ times in this project's short life — gateway stays
# alive, memory monitor still fires, but the dispatcher loop stops
# ticking. Mirrors upstream issues:
#   - NousResearch/hermes-agent#29034 (dispatcher safety / defaults)
#   - NousResearch/hermes-agent#28805 (no per-host config for cap exposure)
#
# This script is a plain `while true` shell loop calling
# `hermes kanban dispatch --max N` once per interval. If the dispatcher
# wedges *inside* the CLI process, the next iteration starts a fresh
# subprocess — no shared state to corrupt.
#
# Usage
# -----
#   scripts/landfolk-dispatcher.sh                       # default: board landfolk-ops, 60s, max=3
#   BOARD=foo INTERVAL=30 MAX=5 scripts/landfolk-dispatcher.sh
#
# Lifecycle
# ---------
# Started/stopped by `scripts/landfolk` alongside the gateway. Not a
# systemd service, not launchd — keep it in the landfolk lifecycle.
set -uo pipefail

BOARD="${BOARD:-landfolk-ops}"
INTERVAL="${INTERVAL:-60}"
MAX="${MAX:-3}"
LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/dispatcher.log}"

mkdir -p "$LOG_DIR"

trap 'echo "[$(date +%H:%M:%S)] dispatcher stopping (SIGTERM)" >>"$LOG_FILE"; exit 0' TERM INT

echo "[$(date +%H:%M:%S)] dispatcher starting: board=$BOARD interval=${INTERVAL}s max=$MAX" >>"$LOG_FILE"

while true; do
  ts=$(date +%H:%M:%S)
  # `hermes kanban dispatch` runs one tick: reclaim stale, detect crashed,
  # promote ready, spawn workers up to --max. Exit code reflects whether
  # the CLI itself succeeded, not whether work was spawned.
  out=$(hermes kanban --board "$BOARD" dispatch --max "$MAX" 2>&1)
  rc=$?
  # Compact summary — full output saved on non-trivial events only.
  spawned=$(echo "$out" | awk '/^Spawned:/ {print $2}')
  reclaimed=$(echo "$out" | awk '/^Reclaimed:/ {print $2}')
  crashed=$(echo "$out" | awk '/^Crashed:/ {print $2}')
  auto_blocked=$(echo "$out" | awk '/^Auto-blocked:/ {print $2}')
  promoted=$(echo "$out" | awk '/^Promoted:/ {print $2}')

  if [ "$rc" -ne 0 ]; then
    echo "[$ts] tick FAILED rc=$rc" >>"$LOG_FILE"
    echo "$out" | sed 's/^/    /' >>"$LOG_FILE"
  elif [ "${spawned:-0}" != "0" ] || [ "${reclaimed:-0}" != "0" ] || \
       [ "${crashed:-0}" != "0" ] || [ "${auto_blocked:-0}" != "0" ] || \
       [ "${promoted:-0}" != "0" ]; then
    echo "[$ts] tick: spawned=$spawned reclaimed=$reclaimed crashed=$crashed promoted=$promoted auto_blocked=$auto_blocked" >>"$LOG_FILE"
  fi
  # quiet ticks (everything zero) skip logging to keep the log tidy

  sleep "$INTERVAL"
done
