#!/usr/bin/env bash
# Non-interactive checks before a Phase D mapping validation run (operator still runs the fleet).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/bin:${PATH:-}"

echo "== Phase D mapping validation — prep =="
bash scripts/establish-mapping-catalog-ensure.sh

echo ""
echo "== Offline grader (shared file; epic skipped) =="
if [[ -f data/personal-pois-shared.json ]]; then
  python3 scripts/establish-mapping-check.py --skip-epic || true
else
  echo "No data/personal-pois-shared.json yet (expected before first reconcile)."
fi

GRADE="data/runtime/last-mapping-grade.json"
if [[ -f "$GRADE" ]]; then
  echo "Last dashboard grade snapshot: $GRADE"
  head -5 "$GRADE"
fi

echo ""
cat <<'EOF'
Operator run (align --fresh-disc seed with catalog map seed per runbook §3):

  export PATH=/opt/homebrew/bin:$PATH
  VARIANT=establishment.mapping scripts/establish-run.sh --fresh-disc <seed> --archive-logs
  ./start-dashboard.sh --world proc-lab
  scripts/kanban board
  python3 scripts/establish-mapping-check.py --skip-epic    # mid-run
  # … fleet …
  scripts/landfolk stop
  scripts/snapshot-fleet-logs.sh data/postmortems/establish-$(date +%Y-%m-%d)-mappingN
  python3 scripts/reconcile-pois.py --auto
  python3 scripts/establish-mapping-check.py

Postmortem: record §12 friction (phantom workers, empty evidence, env leak).
EOF
