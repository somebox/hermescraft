#!/usr/bin/env bash
# stress.sh — thin router over run-fixture.sh and agent-test.py (followup-improvement-pass).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCENARIO="${1:-}"
shift || true

case "$SCENARIO" in
  noop)
    exec "$ROOT/scripts/run-fixture.sh" both "$ROOT/data/test-fixtures/stress/noop.yaml"
    ;;
  advise-on-stuck|recipe-bed-variant|craft-post-56-blue-wool)
    exec "$ROOT/scripts/agent-test.py" "$ROOT/data/agent-tests/playbooks/${SCENARIO}.yaml" "$@"
    ;;
  chop-prose-vs-playbook|chop-preflight-refusal|chop-checkpoint-resume|chop-composition|craft-subcard-file|craft-subcard-unblock|craft-blue_wool-sub-cards|long-range-nav|tower-reuses-pillar-up-safe|tower-mini-pillar|tower-platform-3x3|tower-scaffold-3x3|tower-scaffold-2x2)
    if [[ "$SCENARIO" == "tower-mini-pillar" ]]; then
      SCENARIO=tower-reuses-pillar-up-safe
    fi
    if [[ "$SCENARIO" == "tower-scaffold-2x2" ]]; then
      SCENARIO=tower-scaffold-3x3
    fi
    exec "$ROOT/scripts/agent-test.py" "$ROOT/data/agent-tests/playbooks/${SCENARIO}.yaml" "$@"
    ;;
  "")
    echo "usage: scripts/stress.sh <scenario>" >&2
    echo "  noop, advise-on-stuck, recipe-bed-variant, craft-post-56-blue-wool, …" >&2
    exit 1
    ;;
  *)
    if [[ -f "$ROOT/data/agent-tests/playbooks/${SCENARIO}.yaml" ]]; then
      exec "$ROOT/scripts/agent-test.py" "$ROOT/data/agent-tests/playbooks/${SCENARIO}.yaml" "$@"
    fi
    if [[ -f "$ROOT/data/test-fixtures/stress/${SCENARIO}.yaml" ]]; then
      exec "$ROOT/scripts/run-fixture.sh" both "$ROOT/data/test-fixtures/stress/${SCENARIO}.yaml" "$@"
    fi
    echo "unknown stress scenario: $SCENARIO" >&2
    exit 1
    ;;
esac
