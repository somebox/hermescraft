#!/usr/bin/env bash
# Script obedience smoke — one card must run _smoke_echo.sh early.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOARD="${BOARD:-wheat-capstone}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
RUN_ID="${RUN_ID:-w2-smoke-$(date +%s)}"

BODY="Turn 1 checklist (HERMESCRAFT_REPO is set by dispatcher + role .env):
1. Run: bash \"\${HERMESCRAFT_REPO:-$REPO_ROOT}/data/workspace/production/scripts/_smoke_echo.sh\"
2. Paste output in completion comment (expect: w2-smoke-ok).
3. Do not run other mc verbs until step 1 succeeds."

chmod +x "$REPO_ROOT/data/workspace/production/scripts/_smoke_echo.sh"

CARD="$(hermes kanban --board "$BOARD" create \
  --tenant proto-agent-arch \
  --assignee navigator \
  --body "$BODY" \
  --max-runtime 5m \
  --skill kanban-worker \
  --json \
  "[bot:mox] W2 smoke script obedience $RUN_ID" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"

echo "smoke_card=$CARD — dispatcher must complete; grep logs for w2-smoke-ok"
