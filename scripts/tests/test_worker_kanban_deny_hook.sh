#!/usr/bin/env bash
# Blocks hermes kanban from worker terminal tool; allows scripts/kanban and kanban_* paths.

set -u

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/scripts/hermes-hooks/worker-kanban-deny.sh"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK not executable"
  exit 1
fi

PASS=0
FAIL=0

check() {
  local expect="$1" label="$2" cmd="$3"
  local payload result decision
  payload=$(jq -n --arg c "$cmd" '{hook_event_name:"pre_tool_call",tool_name:"terminal",tool_input:{command:$c}}')
  result=$(printf '%s' "$payload" | "$HOOK" 2>/dev/null)
  decision=$(printf '%s' "$result" | jq -r '.decision // "allow"' 2>/dev/null)
  if [ "$decision" = "$expect" ]; then
    PASS=$((PASS + 1))
  else
    printf '  ✗ %-50s expected=%s got=%s\n' "$label" "$expect" "$decision" >&2
    FAIL=$((FAIL + 1))
  fi
}

check block "hermes kanban list"           "hermes kanban list --board landfolk-ops"
check block "hermes kanban show"           "hermes kanban show t_abc12345"
check block "hermes kanban after &&"       "mc status && hermes kanban boards list"
check allow "scripts/kanban card"          "scripts/kanban card t_abc12345"
check allow "mc observe"                   "mc observe"

echo "── worker kanban deny hook: $PASS pass · $FAIL fail ──"
exit "$FAIL"
