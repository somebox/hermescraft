#!/usr/bin/env bash
# Hermes pre_tool_call hook for the landfolk orchestrator (Steward).
# Blocks direct DB access patterns that bypass scripts/kanban.
#
# Replaces the PATH-stub strategy at scripts/landfolk-control.sh:1118-
# 1265, which leaked because Hermes' terminal subprocess gets a fresh
# bash PATH from /etc/profile (confirmed g-2026-05-29-5: Steward's
# `python3 -c "...UPDATE tasks..."` ran with exit 0).
#
# Profile scoping: this hook lives under ~/.hermes-landfolk-steward/
# so it only loads when HERMES_HOME points here.
#
# Validation:
#   hermes hooks doctor
#   echo '{"hook_event_name":"pre_tool_call","tool_name":"terminal",
#          "tool_input":{"command":"sqlite3 /path/to.db .tables"}}' \
#     | hermes hooks test pre_tool_call --for-tool terminal --payload-file /dev/stdin

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

# Deny: direct sqlite3 against any DB. Steward writes the board via
# scripts/kanban (which records task_events + respects claim locks).
# Match sqlite3 as the INVOKED command — preceded by start-of-line or
# a true shell separator (`;`, `&&`, `||`, `|`, `&`, `<`, `>`, `(`).
# `grep sqlite3 ...` (sqlite3 as an argument to grep) is NOT matched.
if printf '%s' "$cmd" | grep -qE '(^|[;&|<>(])[[:space:]]*sqlite3([[:space:]]|$)'; then
  block "sqlite3 is blocked for the orchestrator. Use scripts/kanban / hermes kanban for board state. If the facade fails, file a [BUG] card and stop — don't improvise."
fi

# Deny: python3 -c (and -m/-i/etc) inline-code escape hatches.
# The PATH stub at scripts/landfolk-control.sh blocked these too but
# leaked through Hermes' terminal subprocess. Catch here instead.
if printf '%s' "$cmd" | grep -qE '(^|[^a-zA-Z0-9_])python3?[[:space:]]+-(c|m|i|-?command)([[:space:]]|$)'; then
  block "python3 -c / -m / -i are blocked for the orchestrator. Run a script file: python3 scripts/<name>.py [args]. If you need a one-off calc, file a [BUG] for re44 to add it."
fi

# Deny: raw SQL writes against the tasks table, even if smuggled via
# a script. Catches `python3 /tmp/foo.py` where foo.py was just written
# to /tmp by Steward — the regex matches the command string here, not
# the file contents, so this is partial coverage. Defense in depth:
# the sqlite3 + python3 -c blocks above cover the common bypass paths.
if printf '%s' "$cmd" | grep -qiE 'UPDATE[[:space:]]+tasks|INSERT[[:space:]]+INTO[[:space:]]+tasks|DELETE[[:space:]]+FROM[[:space:]]+tasks|DROP[[:space:]]+TABLE[[:space:]]+tasks'; then
  block "Direct SQL writes against the tasks table are blocked. Use scripts/kanban (assign / unblock / set-priority / edit / promote / resolve)."
fi

# Default: allow.
printf '{}\n'
