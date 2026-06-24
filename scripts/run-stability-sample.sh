#!/usr/bin/env bash
# Quick stability sample: restart Tester once, then several back-to-back pytest
# invocations (separate processes) to exercise session setup/teardown. ~5 min cap.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/pytest"
MAX_WALL_S="${MAX_WALL_S:-300}"
T0=$(date +%s)
deadline=$((T0 + MAX_WALL_S))

log() { echo "[$(date +%H:%M:%S)] $*"; }
check_deadline() {
  now=$(date +%s)
  if (( now >= deadline )); then
    log "ERROR: wall clock cap ${MAX_WALL_S}s exceeded"
    exit 124
  fi
}

run_pytest() {
  local label="$1"
  shift
  check_deadline
  log "── $label ──"
  if "$PY" "$@" -q --tb=line; then
    log "OK $label"
    return 0
  else
    log "FAIL $label (exit $?)"
    return 1
  fi
}

log "unit: port_registry (no MC)"
run_pytest "unit-port-registry" scripts/tests/test_port_registry.py scripts/tests/test_reset_proc_lab.py::StagedBuildersTest::test_evac_targets_never_includes_tester

log "restart Tester + mvtp"
HERMES_CONSTRUCT_CONTEXT=1 "$ROOT/scripts/restart-tester.sh" --no-sentinel
"$ROOT/.venv/bin/python" -c "
from tests._lib.config import load_config
from tests._lib.rcon import RconClient
RconClient(load_config()).run('mvtp Tester landfolk-test')
"
curl -sf http://localhost:3004/health | "$ROOT/.venv/bin/python" -c \
  "import sys,json; d=json.load(sys.stdin); assert d.get('username')=='Tester' and d.get('connected'); print('health ok')"

FAIL=0
run_pytest "run-1-task-semantics" tests/functional/test_task_semantics.py -m functional || FAIL=1
run_pytest "run-2-door+timeouts" tests/functional/test_door_simple.py tests/functional/test_action_timeouts.py -m functional || FAIL=1
run_pytest "run-3-construct-scoped" tests/functional/building/test_construct_scoped.py -m functional || FAIL=1
run_pytest "run-4-task-idle-only" tests/functional/test_task_semantics.py::test_idle_bot_reports_null_sync_and_terminal_task -m functional || FAIL=1

curl -sf http://localhost:3004/health | "$ROOT/.venv/bin/python" -c \
  "import sys,json; d=json.load(sys.stdin); print('after runs:', d.get('username'), 'connected', d.get('connected'))" || { log "WARN: Tester health failed after runs"; FAIL=1; }

elapsed=$(( $(date +%s) - T0 ))
log "done in ${elapsed}s (cap ${MAX_WALL_S}s) fail=$FAIL"
exit "$FAIL"
