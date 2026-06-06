#!/usr/bin/env bash
# Procedural topic agent test: pool → map → materialize → agent-test-from-map.
# Usage:
#   scripts/scenario-agent-test.sh [variant] [agent-spec.yaml] [-- agent-test.py args…]
#   VARIANT=smoke AGENT_SPEC=… scripts/scenario-agent-test.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/scenario-agent-common.sh
source "$ROOT/scripts/scenario-agent-common.sh"
SCENARIO_PY="${ROOT}/.venv/bin/python"
if [[ ! -x "$SCENARIO_PY" ]]; then
  SCENARIO_PY=python3
fi
export SCENARIO_PY
PY="$SCENARIO_PY"

# Landfolk parity: bot HTTP listener must respond before rcon prep + agent.
scenario_require_bot_listener "${BOT_URL:-$SCENARIO_DEFAULT_BOT_URL}"
AGENT_SPEC="${AGENT_SPEC:-}"
SERVER="${SERVER:-server.local.yaml}"
MATERIALIZE="${MATERIALIZE:-1}"
BOT_URL="${BOT_URL:-http://localhost:3001}"
TRY_SEED="${TRY_SEED:-}"
SKIP_FIND="${SKIP_FIND:-0}"
AUTO_REUSE="${AUTO_REUSE:-1}"
RUNTIME_DIR="${ROOT}/data/runtime"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      break
      ;;
    -*)
      break
      ;;
    *)
      if [[ -z "${VARIANT_SET:-}" ]]; then
        VARIANT="$1"
        VARIANT_SET=1
      elif [[ -z "$AGENT_SPEC" ]]; then
        AGENT_SPEC="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$AGENT_SPEC" ]]; then
  AGENT_SPEC="$("$PY" -c "
from mapcatalog.scenario_registry import load_registry, variant_by_id
import sys
v = variant_by_id(load_registry(), sys.argv[1])
if v and v.agent_test_ref:
    print(v.agent_test_ref)
elif sys.argv[1] == 'smoke':
    print('data/agent-tests/topics/smoke/map-anchor.yaml')
else:
    print('', end='')
" "$VARIANT")"
fi

if [[ -z "$AGENT_SPEC" || ! -f "$AGENT_SPEC" ]]; then
  echo "Set AGENT_SPEC or pass agent spec yaml (variant $VARIANT has no agent_test_ref)." >&2
  exit 1
fi

CATALOG_DIR="$("$PY" -c "
from mapcatalog.scenario_registry import load_registry, variant_by_id
v = variant_by_id(load_registry(), '$VARIANT')
print(v.catalog_dir if v else '')
")"

if [[ ! -f "$SERVER" ]]; then
  echo "Missing $SERVER" >&2
  exit 1
fi

echo "== variant=$VARIANT spec=$AGENT_SPEC =="
"$PY" -m mapcatalog scenario lint --only "$VARIANT"

HAVE_MAP=0
if [[ -n "$CATALOG_DIR" ]] && compgen -G "${CATALOG_DIR}/*.json" >/dev/null 2>&1; then
  HAVE_MAP=1
fi

if [[ "$SKIP_FIND" != "1" && "$HAVE_MAP" -eq 0 && -z "$TRY_SEED" ]]; then
  echo "== empty catalog; refresh $VARIANT (live server) =="
  scripts/scenario-pools.sh refresh --only "$VARIANT" -s "$SERVER" --allow-partial || true
  if compgen -G "${CATALOG_DIR}/*.json" >/dev/null 2>&1; then
    HAVE_MAP=1
  fi
fi

MAT_ARGS=()
[[ "$MATERIALIZE" == "1" ]] && MAT_ARGS+=(--materialize)

SPEC_ARGS=(--spec "$AGENT_SPEC" --variant "$VARIANT" --server "$SERVER")

if [[ -n "$TRY_SEED" ]]; then
  exec "$PY" scripts/agent-test-from-map.py --try-seed "$TRY_SEED" "${SPEC_ARGS[@]}" \
    -- "$@"
fi

if [[ "$HAVE_MAP" -eq 0 ]]; then
  FALLBACK="${TRY_SEED_FALLBACK:-800}"
  echo "== no catalog; TRY_SEED_FALLBACK=$FALLBACK ==" >&2
  exec "$PY" scripts/agent-test-from-map.py --try-seed "$FALLBACK" "${SPEC_ARGS[@]}" \
    -- "$@"
fi

MAP_JSON="$(mktemp)"
trap 'rm -f "$MAP_JSON"' EXIT
scripts/scenario-pools.sh map "$VARIANT" >"$MAP_JSON"
mkdir -p "$RUNTIME_DIR"
cp "$MAP_JSON" "$RUNTIME_DIR/last-scenario-map.json"

SEED="$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['seed'])" "$MAP_JSON")"
echo "seed=$SEED map=$RUNTIME_DIR/last-scenario-map.json"

if [[ "$AUTO_REUSE" == "1" && "$MATERIALIZE" == "1" ]]; then
  if "$PY" -c "
from mapcatalog.proc_state import seed_matches_loaded
from mapcatalog.server_config import load_server_config
from pathlib import Path
import sys
cfg = load_server_config(Path('$SERVER'))
sys.exit(0 if seed_matches_loaded(cfg.world_name, sys.argv[1]) else 1)
" "$SEED"; then
    echo "== AUTO_REUSE: proc-lab already seed $SEED — skip materialize =="
    MAT_ARGS=()
  fi
fi

exec "$PY" scripts/agent-test-from-map.py --map "$MAP_JSON" "${MAT_ARGS[@]}" "${SPEC_ARGS[@]}" \
  -- "$@"
