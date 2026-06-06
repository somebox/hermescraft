#!/usr/bin/env bash
# Start the HermesCraft fleet dashboard (Node HTTP aggregator).
#
# Usage:
#   ./start-dashboard.sh
#   ./start-dashboard.sh --world proc-lab
#   DASHBOARD_WORLD=proc-lab ./start-dashboard.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "Usage: $0 [--world <hermes-world>] [--dev]" >&2
  echo "  Hermes world name from data/agent-registry.json (e.g. world, proc-lab, landfolk-test)." >&2
  echo "  --dev  restart Node on dashboard/*.js changes (node --watch; needs Node 18+)." >&2
  exit 1
}

DEV=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--world)
      [[ $# -ge 2 ]] || usage
      export DASHBOARD_WORLD="$2"
      shift 2
      ;;
    --dev)
      DEV=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

export DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
export BOT_HOST="${BOT_HOST:-127.0.0.1}"
export HERMES_KANBAN_BASE="${HERMES_KANBAN_BASE:-http://127.0.0.1:27124}"
if [[ "$DEV" -eq 1 ]]; then
  exec node --watch "$ROOT/dashboard/server.js"
fi
exec node "$ROOT/dashboard/server.js"
