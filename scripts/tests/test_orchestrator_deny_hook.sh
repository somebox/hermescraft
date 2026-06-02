#!/usr/bin/env bash
# Unit test for scripts/hermes-hooks/orchestrator-deny.sh — the Hermes
# pre_tool_call hook that blocks direct DB access for the orchestrator
# (Steward). Verifies the deny patterns catch the intended bypasses
# (sqlite3 as invoked command, python3 -c/-m/-i, raw SQL writes to
# tasks) without false-positiving on legitimate uses (grep sqlite3 as
# an argument, python3 scripts/foo.py, etc).
#
# Wired into scripts/tests/test_board_environment.sh preflight.

set -u

HOOK="$(cd "$(dirname "$0")/../.." && pwd)/scripts/hermes-hooks/orchestrator-deny.sh"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK not executable"
  exit 1
fi

PASS=0
FAIL=0

# $1 = expected decision ("block" or "allow")
# $2 = label
# $3 = command string to evaluate
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

# ── deny: sqlite3 as invoked command ──
check block "sqlite3 direct"            "sqlite3 ~/.hermes/kanban.db .tables"
check block "sqlite3 with .schema"      "sqlite3 /tmp/x.db '.schema tasks'"
check block "sqlite3 after &&"          "cd /tmp && sqlite3 kanban.db"
check block "sqlite3 after ;"           "ls; sqlite3 kanban.db"
check block "sqlite3 after pipe"        "echo .tables | sqlite3 kanban.db"

# ── deny: python3 inline-code escape hatches ──
check block "python3 -c"                "python3 -c \"import sqlite3; print(1)\""
check block "python3 -m"                "python3 -m json.tool"
check block "python3 -i"                "python3 -i"

# ── deny: raw SQL writes against tasks ──
check block "UPDATE tasks smuggled"     "python3 /tmp/x.py # UPDATE tasks SET assignee='mason'"
check block "INSERT INTO tasks"         "echo \"INSERT INTO tasks VALUES (1)\" | foo"
check block "DELETE FROM tasks"         "echo DELETE FROM tasks"
check block "DROP TABLE tasks"          "echo DROP TABLE tasks"

# ── allow: legitimate orchestrator tools ──
check allow "scripts/kanban board"     "scripts/kanban board"
check allow "scripts/kanban add"       "scripts/kanban add 'foo' --assignee mason --for t_abc"
check allow "scripts/kanban card"      "scripts/kanban card t_abc12345"
check allow "wb context (worker proxy)" "wb context"
check allow "mc status"                 "mc status"
check allow "mc read_chat"              "mc read_chat 20"

# ── A3 (2026-06-02): mc verb allowlist for orchestrator ──
# Read-only observation: allowed
check allow "mc observe"                "mc observe"
check allow "mc scene"                  "mc scene"
check allow "mc marks"                  "mc marks"
check allow "mc nearby"                 "mc nearby 16"
check allow "mc look"                   "mc look"
check allow "mc find"                   "mc find oak_log"
check allow "mc inspect"                "mc inspect 1 2 3"
check allow "mc map"                    "mc map"
check allow "mc terrain_top"            "mc terrain_top 1 2"
check allow "mc list_container"         "mc list_container"
# In-band coordination: allowed
check allow "mc chat"                   "mc chat 'hello workers'"
check allow "mc whisper"                "mc whisper flint 'check NE'"
# Meta/cli: allowed
check allow "mc help"                   "mc help"
check allow "mc goals"                  "mc goals"
check allow "mc task"                   "mc task"

# Field-mutating verbs: denied
check block "mc move denied"            "mc move 5 65 3"
check block "mc goto denied"            "mc goto 10 65 5"
check block "mc goto_near denied"       "mc goto_near 10 65 5 2"
check block "mc bg_goto denied"         "mc bg_goto 10 65 5"
check block "mc go_mark denied"         "mc go_mark base"
check block "mc mark denied"            "mc mark candidate_pad_ne"
check block "mc dig denied"             "mc dig 1 2 3"
check block "mc dig_area denied"        "mc dig_area 0 0 0 5 5 5"
check block "mc place denied"           "mc place cobblestone 1 2 3"
check block "mc collect denied"         "mc collect oak_log 8"
check block "mc deposit denied"         "mc deposit oak_log 8 1 2 3"
check block "mc craft denied"           "mc craft wooden_pickaxe"
check block "mc pillar_up denied"       "mc pillar_up 3"
check block "mc pillar_down denied"     "mc pillar_down 1"
# Chained: deny still fires when the bad verb is downstream
check block "mc status && mc move"      "mc status && mc move 1 2 3"

# ── allow: legitimate python helpers ──
check allow "python3 scripts/roster.py" "python3 scripts/roster.py --assignable"
check allow "python3 reconcile"         "python3 scripts/reconcile-marks.py --auto"
check allow "grep sqlite3 (arg, not cmd)" "grep sqlite3 scripts/*.py"

# ── allow: edge cases ──
check allow "empty command"             ""

echo
echo "── hook regression: $PASS pass · $FAIL fail ──"
exit $FAIL
