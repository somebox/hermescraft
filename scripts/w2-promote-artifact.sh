#!/usr/bin/env bash
# Promote engineer deliverables after overseer REVIEW is done.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_ROOT/data/postmortems/wheat-capstone/_w2_artifacts.json"
PROD_ROOT="$REPO_ROOT/data/workspace/production"
RUN_ID="${1:-}"
ISSUE_ID="${2:-}"

[[ -n "$RUN_ID" && -n "$ISSUE_ID" ]] || {
  echo "usage: w2-promote-artifact.sh <run_id> <issue_id>" >&2
  exit 64
}

case "$ISSUE_ID" in
  W2-AUTO-001) TARGET="$PROD_ROOT/scripts/wheat_plot_bounds.sh"; VERIFY="w2-verify-plot-script.sh" ;;
  W2-AUTO-002) TARGET="$PROD_ROOT/scripts/wheat_chest_coords.sh"; VERIFY="w2-verify-chest-script.sh" ;;
  W2-AUTO-003) TARGET="$PROD_ROOT/data/wheat_survey_cache.json"; VERIFY="w2-verify-survey-cache.sh" ;;
  *) echo "unknown issue $ISSUE_ID"; exit 1 ;;
esac

case "$TARGET" in
  "$PROD_ROOT"/*) ;;
  *) echo "FAIL path prefix gate: $TARGET"; exit 1 ;;
esac
[[ -f "$TARGET" ]] || { echo "missing deliverable $TARGET"; exit 1; }

"$REPO_ROOT/scripts/$VERIFY" "$TARGET"

SHA="$(shasum -a 256 "$TARGET" | awk '{print $1}')"
python3 - <<PY
import json, time
from pathlib import Path
p = Path("$MANIFEST")
data = json.loads(p.read_text())
scripts = data.setdefault("scripts", {})
name = Path("$TARGET").name
entry = scripts.setdefault(name, {})
entry["sha256"] = "$SHA"
entry["promoted_at_run"] = "$RUN_ID"
entry["version"] = int(entry.get("version", 0)) + 1
if "$ISSUE_ID" == "W2-AUTO-003":
    data["survey_cache"] = True
data["version"] = int(data.get("version", 1))
p.write_text(json.dumps(data, indent=2) + "\\n")
PY

python3 - <<PY
import json
from pathlib import Path
reg = Path("$REPO_ROOT/data/postmortems/wheat-capstone/_known_issues.json")
data = json.loads(reg.read_text())
for i in data.get("issues", []):
    if i.get("id") == "$ISSUE_ID":
        i["status"] = "resolved"
        i["resolved_by_run"] = "$RUN_ID"
reg.write_text(json.dumps(data, indent=2) + "\\n")
PY

echo "[promote] $ISSUE_ID → $TARGET"
