#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 -c "from scripts.lib.gv2_card_validator import validate_board_tasks"
python3 -c "from scripts.lib.gv2_establishment_ladder import evaluate_run_dir"
python3 -c "from scripts.lib.gv2_metrics.compare_enrich import enrich_compare"
python3 "$REPO_ROOT/scripts/gv2-establishment-ladder.py" --run-dir "$REPO_ROOT/scripts/tests/fixtures/gv2-run-smoke" >/dev/null
python3 "$REPO_ROOT/scripts/gv2-score-run.py" --run-dir "$REPO_ROOT/scripts/tests/fixtures/gv2-run-smoke" >/dev/null
test ! -f "$REPO_ROOT/scripts/tests/fixtures/_index.json"
echo "gv2 tooling ok"
