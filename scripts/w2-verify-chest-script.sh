#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${1:-$REPO_ROOT/data/workspace/production/scripts/wheat_chest_coords.sh}"
[[ -f "$SCRIPT" ]] || { echo "missing $SCRIPT"; exit 1; }
grep -q 'wheat_chest\|mc marks\|inspect --mark' "$SCRIPT" || {
  echo "FAIL: chest script must use wheat_chest mark or marks API"
  exit 1
}
echo "PASS chest script verifier"
exit 0
