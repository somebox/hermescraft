#!/usr/bin/env bash
# Post-bootstrap launch gate: bots up, progress pos, steward 403, terrain, dispatcher tick.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PY="${ROOT}/.venv/bin/python3"
[[ -x "$PY" ]] || PY=python3

LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
FAIL=0

warn() { echo "WARN: $*" >&2; }
bad() { echo "FAIL: $*" >&2; FAIL=1; }

echo "== establish launch verify =="

echo "-- bot /health --"
"$PY" scripts/establish-bootstrap-verify.py || bad "bootstrap-verify failed"

echo "-- progress pos (last line per worker) --"
for bot in steward mason flint gatherer; do
  f="$LOG_DIR/progress-${bot}.log"
  if [[ ! -f "$f" ]]; then
    warn "missing $f"
    continue
  fi
  line="$(tail -1 "$f" 2>/dev/null || true)"
  if [[ -z "$line" ]]; then
    bad "$bot progress log empty"
    continue
  fi
  if ! printf '%s' "$line" | "$PY" -c "
import json, sys
d = json.loads(sys.stdin.read())
p = d.get('pos')
sys.exit(0 if isinstance(p, dict) and all(k in p for k in ('x','y','z')) else 1)
"; then
    bad "$bot last progress line has pos:null or missing"
  else
    echo "  $bot: pos ok"
  fi
done

echo "-- steward HTTP gate --"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3005/action/tunnel 2>/dev/null || echo 000)"
if [[ "$code" != "403" ]]; then
  bad "steward POST /action/tunnel expected 403 got $code"
else
  echo "  steward tunnel: 403"
fi

wcode="$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3001/action/tunnel 2>/dev/null || echo 000)"
if [[ "$wcode" == "403" ]]; then
  bad "gatherer POST /action/tunnel should not be 403"
else
  echo "  gatherer tunnel: $wcode (not 403)"
fi

echo "-- steward mc observe (CLI) --"
if BOT_URL=http://localhost:3005 node bot/cli/index.mjs observe 2>/dev/null | head -1 | grep -q 'Surface at\|Underground at'; then
  echo "  steward observe: nav header present"
else
  warn "steward observe did not print Surface/Underground line (bot down or CLI error)"
fi

echo "-- kanban dispatcher --"
dlog="$LOG_DIR/dispatcher.log"
gwlog="${HOME}/.hermes/logs/gateway.log"
if pgrep -fl 'landfolk-dispatcher' >/dev/null 2>&1 && [[ -f "$dlog" ]]; then
  last="$(tail -1 "$dlog" 2>/dev/null || true)"
  echo "  standalone: ${last:-empty}"
elif [[ -f "$gwlog" ]] && grep -q 'kanban dispatcher: embedded' "$gwlog" 2>/dev/null; then
  echo "  gateway-embedded: ok ($(grep 'kanban dispatcher' "$gwlog" | tail -1))"
else
  warn "no standalone dispatcher.log tick and no embedded line in gateway.log — check kanban.dispatch_in_gateway"
fi

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
echo "== establish launch verify OK =="
