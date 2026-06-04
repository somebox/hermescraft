#!/usr/bin/env bash
# Ensure establishment.mapping catalog has at least one map JSON.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VARIANT=establishment.mapping
PY="${ROOT}/.venv/bin/python3"
[[ -x "$PY" ]] || PY=python3

"$PY" -m mapcatalog scenario lint --only "$VARIANT" 2>/dev/null || true

CATALOG_DIR="$("$PY" -c "
from mapcatalog.scenario_registry import load_registry, variant_by_id
v = variant_by_id(load_registry(), '$VARIANT')
print(v.catalog_dir if v else '')
")"

if [[ -z "$CATALOG_DIR" ]]; then
  echo "No catalog dir for $VARIANT" >&2
  exit 1
fi

if compgen -G "${CATALOG_DIR}/*.json" >/dev/null 2>&1; then
  echo "Catalog OK: $CATALOG_DIR ($(ls -1 "${CATALOG_DIR}"/*.json | wc -l | tr -d ' ') maps)"
  scripts/scenario-pools.sh map "$VARIANT" | "$PY" -c "import json,sys; m=json.load(sys.stdin); print('sample seed', m.get('seed'))"
  exit 0
fi

echo "== refresh $VARIANT catalog =="
SERVER="${SERVER:-server.local.yaml}"
scripts/scenario-pools.sh refresh --only "$VARIANT" -s "$SERVER" --allow-partial
scripts/scenario-pools.sh map "$VARIANT" | "$PY" -c "import json,sys; m=json.load(sys.stdin); print('seed', m.get('seed'))"
