#!/usr/bin/env bash
# Start the HermesCraft fleet dashboard (Node HTTP aggregator).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export DASHBOARD_PORT="${DASHBOARD_PORT:-3000}"
export BOT_HOST="${BOT_HOST:-127.0.0.1}"
export HERMES_KANBAN_BASE="${HERMES_KANBAN_BASE:-http://127.0.0.1:27124}"
exec node "$ROOT/dashboard/server.js"
