#!/usr/bin/env bash
# wheat-w1-trial.sh — operator phases for W1 role-agent wheat capstone.
#
# Usage:
#   scripts/wheat-w1-trial.sh prep|live|evaluate|feedback|teardown
#
# Requires: HERMES_HOME, MC_HOST (for colony), optional RUN_ID / DISPATCHER_LOG.
set -u

PHASE="${1:-}"
if [[ -z "$PHASE" ]]; then
  echo "usage: $0 prep|live|evaluate|feedback|teardown" >&2
  exit 2
fi

export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export W1_MODE=role
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
PY="${PY:-$REPO_ROOT/.venv/bin/python}"
[[ -x "$PY" ]] || PY=python3

case "$PHASE" in
  prep)
    scripts/reset-wheat-capstone.sh
    prototypes/agent-arch/setup-role-profiles.sh
    scripts/run-tester-bot.sh
    MC_HOST="${MC_HOST:-192.168.1.202}" scripts/colony start mox
    scripts/run-fixture.sh prep data/test-fixtures/colony/wheat_capstone.yaml
    scripts/validate-wheat-fixture.sh
    scripts/preflight-wheat.sh
    prototypes/agent-arch/capstone/preflight.sh
    HERMES_HOME="$HERMES_HOME" "$PY" prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --dry-run --board wheat-capstone
    "$PY" -m pytest \
      prototypes/agent-arch/tests/test_capstone_scaffold.py \
      prototypes/agent-arch/tests/test_w1_card_skills_contract.py \
      prototypes/agent-arch/tests/test_w1_handoff_x001_x002.py -q
    ;;
  live)
    RUN_ID="${RUN_ID:-w1-$(date +%s)}"
    DISPATCHER_LOG="${DISPATCHER_LOG:-/tmp/wheat-dispatcher-${RUN_ID}.log}"
    echo "$RUN_ID" | tee /tmp/wheat-current-run-id
    scripts/wheat-dispatcher.sh >>"$DISPATCHER_LOG" 2>&1 &
    echo $! >/tmp/wheat-dispatcher-w1-pid
    HERMES_HOME="$HERMES_HOME" "$PY" prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --run-id "$RUN_ID" --board wheat-capstone --watch
    ;;
  evaluate)
    RUN_ID="${RUN_ID:-$(cat /tmp/wheat-current-run-id 2>/dev/null || true)}"
    if [[ -z "$RUN_ID" ]]; then
      echo "set RUN_ID or run live phase first" >&2
      exit 1
    fi
    HERMES_HOME="$HERMES_HOME" "$PY" prototypes/agent-arch/capstone/run_wheat_capstone.py \
      --run-id "$RUN_ID" --evaluate-only
    W1_RUN_ID="$RUN_ID" HERMES_HOME="$HERMES_HOME" "$PY" -m pytest \
      prototypes/agent-arch/tests/test_w1_handoff_x001_x002.py -q
    ;;
  feedback)
    RUN_ID="${RUN_ID:-$(cat /tmp/wheat-current-run-id 2>/dev/null || true)}"
    scripts/collect-trial-feedback.sh --run-id "$RUN_ID" --board wheat-capstone
    ;;
  teardown)
    kill "$(cat /tmp/wheat-dispatcher-w1-pid 2>/dev/null)" 2>/dev/null || true
    scripts/reset-wheat-capstone.sh
    ;;
  *)
    echo "unknown phase: $PHASE" >&2
    exit 2
    ;;
esac
