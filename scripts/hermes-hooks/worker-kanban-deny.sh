#!/usr/bin/env bash
# Hermes pre_tool_call hook for landfolk kanban workers (flint, mason, gatherer, …).
# Blocks `hermes kanban` CLI from the terminal tool — workers must use kanban_* tools
# or scripts/kanban card (see skills/kanban-worker.md).

set -u

payload="$(cat -)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"

if [ -z "$cmd" ]; then
  printf '{}\n'
  exit 0
fi

block() {
  jq -n --arg reason "$1" '{decision:"block", reason:$reason}'
  exit 0
}

# Match hermes kanban at line start or after a shell separator (same pattern as orchestrator mc).
if printf '%s' "$cmd" | grep -qE '(^|[;&|<>(])[[:space:]]*hermes[[:space:]]+kanban([[:space:]]|$)'; then
  block "hermes kanban CLI is blocked for kanban workers. Use kanban_show / kanban_comment / other kanban_* tools, or scripts/kanban card \$HERMES_KANBAN_TASK for a short re-read. See skills/kanban-worker.md."
fi

printf '{}\n'
exit 0
