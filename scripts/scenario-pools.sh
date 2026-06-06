#!/usr/bin/env bash
# Lint or refresh mapcatalog seed pools from data/scenarios/registry.yaml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="${ROOT}/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY=python3
fi

cmd="${1:-help}"
shift || true

case "$cmd" in
  lint)
    exec "$PY" -m mapcatalog scenario lint "$@"
    ;;
  list)
    exec "$PY" -m mapcatalog scenario list "$@"
    ;;
  refresh)
    exec "$PY" -m mapcatalog scenario refresh "$@"
    ;;
  card|map)
    exec "$PY" -m mapcatalog scenario card "$@"
    ;;
  smoke)
    exec "$PY" -m mapcatalog scenario refresh --smoke-only "$@"
    ;;
  help|*)
    cat <<'EOF'
Usage: scripts/scenario-pools.sh <command> [args…]

  lint              Lint all registered requirements YAML
  list              Show topics / terrains / catalog paths
  refresh           Run mapcatalog find for each terrain (needs server.local.yaml)
  refresh --only ID   topic.terrain, topic name, smoke, or legacy_variant_id
  smoke             refresh --smoke-only (map engine check)
  map VARIANT       Print random catalog map JSON (+ _scenario meta)

Examples:
  scripts/scenario-pools.sh lint
  scripts/scenario-pools.sh refresh --only scenario_homestead_smoke -s server.local.yaml
  scripts/scenario-pools.sh refresh --only resource --allow-partial
  scripts/scenario-pools.sh card scenario_worksite_flat --meta-only
EOF
    ;;
esac
