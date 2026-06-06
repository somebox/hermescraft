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
# Per-assignee mutex
# ------------------
# Hermes' `--max N` is a *global* concurrency cap, not per-assignee. The
# per-assignee enforcement lives in the `landfolk` plugin (commit
# 2026-05-27 via docs/features/landfolk-plugin.md). Each tick we call
# `hermes landfolk gate-check` before `hermes kanban dispatch`; the
# plugin parks excess ready cards via `claim_lock=mutex_park:<assignee>`,
# parks orchestrator (steward) cards via `claim_lock=orch_continuous:`,
# and promotes the next-best todo when an assignee frees up.
#
# Previously this script carried ~260 lines of inline Python doing the
# same enforcement via `task_links` chain construction. That worked but
# overloaded the edge set (mutex chains indistinguishable from real
# domain dependencies — see commits 1995335, 198151e, 338cccd). The
# plugin uses claim_lock parking instead, leaving `task_links` clean.
#
# Usage
# -----
#   scripts/landfolk-dispatcher.sh                       # default: board landfolk-ops, 60s, max=3
#   BOARD=foo INTERVAL=30 MAX=5 scripts/landfolk-dispatcher.sh
#
# Kill switch
# -----------
# Set LANDFOLK_DISABLE_GATE=1 to skip the gate-check pass without
# disabling the plugin. The dispatcher continues to spawn workers as
# Hermes' built-in scheduler decides.
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

# Use absolute path for hermes so the orchestrator sandbox stub (per-profile
# restricted_bin/hermes for Steward) never binds the dispatcher. Observed
# g-2026-05-28-5: steward's stubs leaked into the dispatcher's PATH after
# a deploy/restart, causing every tick to log "gate-check FAILED" because
# the stub message ("ERROR: 'hermes landfolk gate-check' is run automatically
# by the dispatcher.") landed in dispatcher.log as if it were a real failure.
# The orchestrator stub is correct policy for Steward; it must never bind
# the dispatcher itself. Pinning the binary keeps the two enforcement layers
# from interfering.
HERMES_BIN="${HERMES_BIN:-/Users/foz/.local/bin/hermes}"
if [ ! -x "$HERMES_BIN" ]; then
  HERMES_BIN="$(command -v hermes 2>/dev/null || echo hermes)"
fi

# Scrub HERMES_HOME (and other HERMES_* env vars) inherited from a parent
# context — e.g. a sandboxed Steward agent terminal that exports
# HERMES_HOME=/Users/foz/.hermes-landfolk-steward. If the dispatcher
# inherits that, `hermes` loads plugins from steward's restricted home,
# the landfolk plugin isn't installed there, and every tick logs
# "invalid choice: 'landfolk'" → "gate-check FAILED". Observed
# g-2026-05-28-6: a second dispatcher spawned from inside Steward's
# session ran in parallel with the clean one, alternating ticks failed.
# HERMES_BIN already pins the binary path (above); this pins HERMES_HOME
# to the operator's real ~/.hermes so plugin discovery works.
unset HERMES_HOME
unset HERMES_PROFILE
unset HERMES_MODEL
unset HERMES_PROVIDER
# Operator / Steward continuous sessions export MC routing vars; the
# standalone dispatcher must not pass them into `hermes kanban dispatch`.
unset _MC_API_URL_LOCKED
unset MC_API_URL
unset MC_USERNAME
unset BASH_ENV

mkdir -p "$LOG_DIR"

trap 'echo "[$(date +%H:%M:%S)] dispatcher stopping (SIGTERM)" >>"$LOG_FILE"; exit 0' TERM INT

echo "[$(date +%H:%M:%S)] dispatcher starting: board=$BOARD interval=${INTERVAL}s max=$MAX" >>"$LOG_FILE"

# Per-assignee mutex enforcement moved into the `landfolk` plugin
# (`plugins/landfolk/landfolk/orchestrator/`). The plugin's CLI verb
# `hermes landfolk gate-check` runs each tick below before
# `hermes kanban dispatch`. See docs/features/landfolk-plugin.md.

while true; do
  ts=$(date +%H:%M:%S)

  # Pre-flight: enforce per-assignee mutex + park orchestrator cards
  # via the landfolk plugin. The plugin writes its own one-line summary
  # to $LOG_FILE on non-trivial ticks; the `|| echo ... FAILED` clause
  # logs catastrophic failures (e.g. plugin not installed) and lets the
  # dispatcher continue with Hermes' built-in scheduling.
  "$HERMES_BIN" landfolk gate-check --board "$BOARD" >/dev/null 2>>"$LOG_FILE" \
    || echo "[$ts] gate-check FAILED — falling through to dispatch" >>"$LOG_FILE"

  # `hermes kanban dispatch` runs one tick: reclaim stale, detect crashed,
  # promote ready, spawn workers up to --max. Exit code reflects whether
  # the CLI itself succeeded, not whether work was spawned.
  out=$("$HERMES_BIN" kanban --board "$BOARD" dispatch --max "$MAX" 2>&1)
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
  else
    # Heartbeat for quiet ticks. Previously we skipped logging entirely
    # when nothing happened, which made a quiet but functional dispatcher
    # indistinguishable from a hung one — operators (and Steward) couldn't
    # tell a tidy log from a frozen process. 2026-05-26: Steward filed an
    # [INFRA] card declaring the dispatcher offline after 32min of silence;
    # the dispatcher was actually ticking normally on a stable board.
    # One terse line per tick costs ~60 lines/hour, trivially manageable,
    # and gives observability where it was missing.
    echo "[$ts] tick: idle (no spawns / reclaims / promotions; plugin gate-check silent)" >>"$LOG_FILE"
  fi

  sleep "$INTERVAL"
done
