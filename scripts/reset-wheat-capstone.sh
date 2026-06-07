#!/usr/bin/env bash
# reset-wheat-capstone.sh — bring the wheat capstone back to a clean
# pre-trial state. Designed to run between trials OR as the first step
# of the playbook's launch sequence.
#
# What it resets (in order):
#   1. Kill any leftover runner / dispatcher / worker processes.
#   2. Stop any in-flight cron monitor task (caller's responsibility
#      via TaskStop — not handled here, but logged as a reminder).
#   3. Archive every card on the wheat-capstone board (done, todo,
#      blocked, running — everything). Trial-launch creates fresh
#      cards every time; we don't preserve any.
#   4. tp Tester back to overworld spawn (0, 65, 0) so he's not
#      standing in the plot the next trial will build on.
#   5. tp Mox back to overworld spawn — fixture prep will move him
#      to wheat_start later.
#   6. Run fixture cleanup (drops world blocks, restores randomTickSpeed,
#      removes state file + leftover cron jobs).
#   7. Zero pilot-mox memory file.
#   8. Confirm board empty, no state files, no leftover crons.
#
# What it does NOT do:
#   - Touch Pip/Zee (they're typically idle outside landfolk-test).
#   - Move trial postmortem dirs (caller does this so RUN_IDs don't
#     collide).
#   - Re-stage the fixture (do that with run-fixture.sh prep after).
#
# Usage:
#   scripts/reset-wheat-capstone.sh
#
# Env:
#   HERMES_HOME (default: ~/.hermes)
#   BOARD       (default: wheat-capstone)
#   MC_HOST_SSH (default: ubuntu-host)
set -u

export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
BOARD="${BOARD:-wheat-capstone}"
MC_HOST_SSH="${MC_HOST_SSH:-ubuntu-host}"
MC_DOCKER_NAME="${MC_DOCKER_NAME:-minecraft}"

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

log() { printf '[reset] %s\n' "$*"; }

# ── 1. Kill running trial processes ─────────────────────────────────
log "stopping any running trial processes"
for pidfile in /tmp/wheat-runner-pid /tmp/wheat-dispatcher-pid; do
  if [[ -f "$pidfile" ]]; then
    pid=$(cat "$pidfile" 2>/dev/null)
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null && log "  killed $(basename "$pidfile") pid=$pid"
    fi
    rm -f "$pidfile"
  fi
done
if pgrep -f "hermes -p pilot-mox.*work kanban task" >/dev/null 2>&1; then
  pkill -f "hermes -p pilot-mox.*work kanban task" 2>/dev/null
  log "  killed leftover pilot-mox worker"
fi
sleep 1

# ── 2. Monitor reminder ─────────────────────────────────────────────
log "REMINDER: if a Monitor task is armed, call TaskStop on it before relaunching"

# ── 3. Archive every card on the board ──────────────────────────────
# POSIX awk doesn't support \s — match the leading status glyph then
# any space then the t_<hex> id. Glyphs vary by status:
#   ● running    ◻ todo    ▶ ready    ✓ done    ⊘ blocked    ✗ archived
log "archiving all cards on board=$BOARD"
card_ids=$(hermes kanban --board "$BOARD" list 2>/dev/null \
  | grep -oE "t_[0-9a-f]+" | sort -u)
if [[ -z "$card_ids" ]]; then
  log "  board already empty"
else
  count=$(echo "$card_ids" | wc -l | tr -d ' ')
  log "  found $count cards — archiving"
  echo "$card_ids" | xargs hermes kanban --board "$BOARD" archive 2>&1 \
    | grep -E "^Archived" | sed 's/^/  /'
fi

# ── 4 + 5. tp bots to safe positions ────────────────────────────────
log "tp Tester and Mox to overworld spawn (0, 65, 0)"
ssh -n "$MC_HOST_SSH" "sudo docker exec $MC_DOCKER_NAME rcon-cli 'execute in overworld run tp Tester 0 65 0'" 2>&1 \
  | grep -E "Teleported|Error" | sed 's/^/  /'
ssh -n "$MC_HOST_SSH" "sudo docker exec $MC_DOCKER_NAME rcon-cli 'execute in overworld run tp Mox 0 65 0'" 2>&1 \
  | grep -E "Teleported|Error" | sed 's/^/  /'

# ── 6. Fixture cleanup ──────────────────────────────────────────────
log "running fixture cleanup"
"$REPO_ROOT/scripts/run-fixture.sh" cleanup data/test-fixtures/colony/wheat_capstone.yaml \
  2>&1 | tail -2 | sed 's/^/  /'

# ── 7. Zero pilot-mox memory ────────────────────────────────────────
log "zeroing pilot-mox memory"
mem="$HERMES_HOME/profiles/pilot-mox/memories/MEMORY.md"
if [[ -f "$mem" ]]; then
  : > "$mem"
  log "  zeroed $mem"
fi

# ── 8. Final verification ───────────────────────────────────────────
log "verifying clean state"
remaining=$(hermes kanban --board "$BOARD" list 2>/dev/null \
  | grep -oE "t_[0-9a-f]+" | sort -u | wc -l | tr -d ' ')
log "  board cards remaining: $remaining"

cron_count=$(hermes cron list 2>/dev/null | grep -c wheat-harvest-reminder || true)
log "  leftover wheat-harvest-reminder crons: $cron_count"

if [[ -f "$HOME/.hermes/state/wheat-harvest-pending.txt" ]]; then
  log "  state file: STILL PRESENT (should have been cleaned)"
else
  log "  state file: clean"
fi

log "reset complete. Next step: scripts/run-fixture.sh prep data/test-fixtures/colony/wheat_capstone.yaml"
