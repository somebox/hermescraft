#!/usr/bin/env bash
# Pre-flight verification harness for the kanban worker-proxy environment.
#
# Designed to fail fast (≤5s) on a clean checkout before any bots come up,
# so a genesis cycle isn't wasted discovering that the CLI is broken or the
# DB is missing a column.
#
# Checks (commit-A scope — Steward-side `kanban board` etc. arrive in commit B):
#   1. `scripts/wb --help` exits 0
#   2. `scripts/wb context` with no HERMES_KANBAN_TASK fails with a friendly
#      error that mentions the env var name
#   3. `scripts/wb --task <bogus> context` against an empty DB fails clearly
#   4. The live landfolk-ops DB has the four card-meta columns
#      (location_x/y/z + size)
#   5. The migration is idempotent: rerunning it against the live DB adds
#      nothing
#   6. `scripts/kanban --help` exits 0 (Steward CLI still operational)
#   7. The wb pytest module passes
#   8. The card-meta migration pytest module passes
#
# Exit codes:
#   0 = all checks passed (board environment is ready)
#   1 = at least one check failed (see preceding output for which)
#
# Usage: scripts/tests/test_board_environment.sh
#        (run from repo root; uses absolute paths internally)

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WB="${REPO_ROOT}/scripts/wb"
KANBAN="${REPO_ROOT}/scripts/kanban"
MIGRATION="${REPO_ROOT}/scripts/migrations/add_card_meta_cols.py"
BOARD="${HERMES_KANBAN_BOARD:-landfolk-ops}"
LIVE_DB="${HERMES_KANBAN_DB:-${HOME}/.hermes/kanban/boards/${BOARD}/kanban.db}"

PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
bad()  { echo "  ✗ $*" >&2; FAIL=$((FAIL + 1)); }
step() { echo; echo "── $* ──"; }

run_quiet() { "$@" >/tmp/pre-flight.$$.out 2>/tmp/pre-flight.$$.err; }
last_out()  { cat /tmp/pre-flight.$$.out 2>/dev/null; }
last_err()  { cat /tmp/pre-flight.$$.err 2>/dev/null; }
cleanup()   { rm -f /tmp/pre-flight.$$.out /tmp/pre-flight.$$.err; }
trap cleanup EXIT

echo "Pre-flight: kanban worker-proxy environment"
echo "  board: ${BOARD}"
echo "  db:    ${LIVE_DB}"

step "1. wb --help"
if run_quiet "${WB}" --help && last_out | grep -q "worker board proxy"; then
  ok "wb --help OK"
else
  bad "wb --help failed or missing expected docstring"
  last_err >&2
fi

step "2. wb context with no active card"
unset HERMES_KANBAN_TASK
if run_quiet "${WB}" context; then
  bad "wb context with no env succeeded (should have failed)"
else
  if last_err | grep -q "HERMES_KANBAN_TASK"; then
    ok "wb context with no env fails clearly"
  else
    bad "wb context error didn't mention HERMES_KANBAN_TASK"
    last_err >&2
  fi
fi

step "3. wb --task <bogus> context"
if run_quiet "${WB}" --task t_doesnotexist context; then
  bad "wb context with bogus card succeeded (should have failed)"
else
  if last_err | grep -q "no card"; then
    ok "wb context with unknown card fails clearly"
  else
    bad "wb context unknown-card error wording surprising"
    last_err >&2
  fi
fi

step "4. live DB has card-meta columns"
if [ ! -f "${LIVE_DB}" ]; then
  bad "live DB missing at ${LIVE_DB} — run scripts/migrations/add_card_meta_cols.py?"
else
  cols=$(sqlite3 "${LIVE_DB}" "PRAGMA table_info(tasks);" 2>/dev/null \
         | awk -F'|' '{print $2}')
  missing=""
  for c in location_x location_y location_z size; do
    if ! printf '%s\n' "${cols}" | grep -qx "${c}"; then
      missing="${missing} ${c}"
    fi
  done
  if [ -z "${missing}" ]; then
    ok "tasks has location_x/y/z + size"
  else
    bad "tasks is missing:${missing}"
  fi
fi

step "5. migration is idempotent against live DB"
if [ -f "${LIVE_DB}" ]; then
  if run_quiet python3 "${MIGRATION}" --db "${LIVE_DB}" --quiet \
     && run_quiet python3 "${MIGRATION}" --db "${LIVE_DB}" --quiet; then
    ok "migration runs cleanly twice in a row"
  else
    bad "migration is not idempotent on live DB"
    last_err >&2
  fi
else
  bad "skipping idempotency check — live DB missing"
fi

step "6. scripts/kanban --help"
if run_quiet "${KANBAN}" --help && last_out | grep -q "kanban"; then
  ok "scripts/kanban --help OK"
else
  bad "scripts/kanban --help failed"
  last_err >&2
fi

step "7. all worker-board-proxy pytests"
if run_quiet sh -c "cd '${REPO_ROOT}' && uv run pytest \
    scripts/tests/test_card_meta_migration.py \
    scripts/tests/test_wb_environment.py \
    scripts/tests/test_kanban_action_verbs.py \
    scripts/tests/test_lifecycle_smoke.py \
    -q --no-header"; then
  ok "pytest suites pass (migration / wb / kanban verbs / lifecycle smoke)"
else
  bad "pytest suite failed"
  last_out >&2
  last_err >&2
fi

step "8. chat→comment node test"
if run_quiet sh -c "cd '${REPO_ROOT}' && node --test bot/test/server/chat-card-comment.test.js"; then
  ok "chat→comment hook tests pass"
else
  bad "chat→comment tests failed"
  last_out >&2
  last_err >&2
fi

step "9. orchestrator-deny hook regression"
if run_quiet "${REPO_ROOT}/scripts/tests/test_orchestrator_deny_hook.sh"; then
  ok "orchestrator-deny hook patterns OK"
else
  bad "orchestrator-deny hook regression"
  last_out >&2
  last_err >&2
fi

echo
echo "──────────────────────────────────────"
echo "  pre-flight: ${PASS} pass · ${FAIL} fail"
echo "──────────────────────────────────────"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
