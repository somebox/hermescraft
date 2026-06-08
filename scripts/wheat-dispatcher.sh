#!/usr/bin/env bash
# Board-scoped dispatcher for wheat-capstone (W1). Exports Mox MC_* once per
# process; workers inherit via role profile env_passthrough.
#
# Usage:
#   HERMES_HOME=~/.hermes scripts/wheat-dispatcher.sh
#   # logs to stderr; redirect as needed

set -u

export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
BOARD="${BOARD:-wheat-capstone}"
DISPATCH_MAX="${DISPATCH_MAX:-5}"
SLEEP_S="${SLEEP_S:-10}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOX_YAML="$REPO_ROOT/data/bots/mox.yaml"

if [[ ! -f "$MOX_YAML" ]]; then
  echo "FATAL: missing $MOX_YAML" >&2
  exit 1
fi

api_port=$(awk '/^api_port:/ {print $2}' "$MOX_YAML")
user=$(awk '/^username:/ {print $2}' "$MOX_YAML")
url="http://127.0.0.1:${api_port}"

export MC_API_URL="$url"
export _MC_API_URL_LOCKED="$url"
export MC_USERNAME="$user"

echo "[wheat-dispatcher] HERMES_HOME=$HERMES_HOME board=$BOARD MC_API_URL=$url MC_USERNAME=$user" >&2

while true; do
  echo "[wheat-dispatcher] tick $(date -Iseconds)" >&2
  hermes landfolk gate-check --board "$BOARD" >&2 || true
  hermes kanban --board "$BOARD" dispatch --max "$DISPATCH_MAX" >&2 || true
  sleep "$SLEEP_S"
done
