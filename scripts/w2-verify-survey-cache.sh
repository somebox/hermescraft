#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${1:-$REPO_ROOT/data/workspace/production/data/wheat_survey_cache.json}"
[[ -f "$CACHE" ]] || { echo "missing $CACHE"; exit 1; }
python3 -c "import json; d=json.load(open('$CACHE')); assert 'marks' in d or 'grid' in d"
echo "PASS survey cache schema"
exit 0
