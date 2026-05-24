#!/usr/bin/env bash
# DEPRECATED — use `scripts/landfolk` instead.
#
# This shim translates the most common old verbs and forwards. It will
# be removed in a future cleanup. Migration map:
#
#   landfolk-session.sh up      → scripts/landfolk start
#   landfolk-session.sh down    → scripts/landfolk stop
#   landfolk-session.sh status  → scripts/landfolk status
#   landfolk-session.sh restart → scripts/landfolk restart
#   landfolk-session.sh logs    → scripts/landfolk logs
#   landfolk-session.sh chat    → scripts/landfolk chat
#   landfolk-session.sh fix     → scripts/landfolk fix

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NEW="$SCRIPT_DIR/scripts/landfolk"

if [ -t 2 ]; then
  printf '\033[33m[deprecated]\033[0m landfolk-session.sh → use `scripts/landfolk` (forwarding now)\n' >&2
else
  echo "[deprecated] landfolk-session.sh → use scripts/landfolk" >&2
fi

CMD="${1:-}"; shift || true
case "$CMD" in
  up)   exec "$NEW" start "$@" ;;
  down) exec "$NEW" stop "$@" ;;
  "")   exec "$NEW" ;;
  *)    exec "$NEW" "$CMD" "$@" ;;
esac
