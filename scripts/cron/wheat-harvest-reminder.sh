#!/usr/bin/env bash
# wheat-harvest-reminder.sh — one-shot cron job that unblocks a pending
# wheat harvest card. Designed for the wheat capstone trial's
# scheduled-operations test (see docs/architecture/scheduled-operations.md).
#
# Contract:
#   - The planter card (x003) writes the harvest card's task id to
#     ~/.hermes/state/wheat-harvest-pending.txt before creating the cron.
#   - This script reads that file, runs `hermes kanban unblock` against
#     the wheat-capstone board, and removes the state file.
#   - Stateless: if the file is absent (already processed, or planter
#     failed mid-write), exit 0 silently.
#
# Trial-scoped — production version would consult the field registry
# rather than a flat state file. This shape is documented in the
# scheduled-operations doc as a deliberate trial simplification.
#
# Logs every run to ~/.hermes/logs/wheat-harvest-reminder.log so a
# failed unblock is auditable post-trial.
#
# Installed at ~/.hermes/scripts/wheat-harvest-reminder.sh by
# prototypes/agent-arch/setup-pilot-mox-live.sh (idempotent).
set -u

STATE_FILE="$HOME/.hermes/state/wheat-harvest-pending.txt"
LOG_FILE="$HOME/.hermes/logs/wheat-harvest-reminder.log"
BOARD="${WHEAT_BOARD:-wheat-capstone}"

mkdir -p "$(dirname "$LOG_FILE")"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG_FILE"; }

log "fired"

if [[ ! -f "$STATE_FILE" ]]; then
  log "state file absent — nothing to unblock; exit 0"
  exit 0
fi

TASK_ID=$(head -1 "$STATE_FILE" | tr -d '[:space:]')
if [[ -z "$TASK_ID" ]]; then
  log "state file empty — cleaning up; exit 0"
  rm -f "$STATE_FILE"
  exit 0
fi

# Run unblock; capture exit code separately so we always clean up.
hermes kanban --board "$BOARD" unblock "$TASK_ID" \
  --reason "wheat mature (one-shot reminder fired at $(ts))" \
  >> "$LOG_FILE" 2>&1
rc=$?
log "unblock task=$TASK_ID board=$BOARD rc=$rc"

# Always remove the state file — even if unblock failed. The cron is
# one-shot (repeat=1); we shouldn't keep retrying a dead state.
rm -f "$STATE_FILE"
log "cleanup complete; state file removed"

exit "$rc"
