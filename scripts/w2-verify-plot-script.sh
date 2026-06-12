#!/usr/bin/env bash
# Verifier: wheat_plot_bounds.sh uses marks API, not hardcoded discovery coords.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${1:-$REPO_ROOT/data/workspace/production/scripts/wheat_plot_bounds.sh}"
[[ -f "$SCRIPT" ]] || { echo "missing $SCRIPT"; exit 1; }
if grep -E '\-5[0-9],\s*64,\s*5[0-9]' "$SCRIPT" 2>/dev/null; then
  echo "FAIL: hardcoded capstone coords in plot script"
  exit 1
fi
grep -q 'mc marks\|inspect --mark\|HERMESCRAFT_REPO' "$SCRIPT" || {
  echo "FAIL: script must reference marks or HERMESCRAFT_REPO"
  exit 1
}
echo "PASS plot script verifier"
exit 0
