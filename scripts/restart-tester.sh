#!/usr/bin/env bash
# Verified Tester restart — makes functional runs repeatable.
#
# The problem this fixes: `stop-bots.sh Tester` reaps by wrapper *ancestry*, so
# an orphaned `node server.js` (PPID=1, started by a different wrapper) keeps
# holding :3004. A new bot then crashes on EADDRINUSE while /health is answered
# by the orphan — tests silently validate STALE code. (Bit us 3× in one
# session; see the bot-restart memory note.)
#
# This wrapper reaps by PORT (orphan-safe — only Tester uses :3004; Steve is
# :3001), starts fresh, and ASSERTS the listener is the new, responsive process
# before returning non-zero on any failure. Because the port is verified empty
# before start, the post-start listener is guaranteed to be freshly-launched
# code — no etime guesswork.
#
# Usage: ./scripts/restart-tester.sh [--sentinel <action>]
#   --sentinel <action>  also POST /action/<action> {} and require ok:true
#                        (default: mine_list — proves the current verb set loaded)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${API_PORT:-3004}"
SENTINEL="mine_list"
while [ $# -gt 0 ]; do
  case "$1" in
    --sentinel) SENTINEL="${2:-}"; shift 2 ;;
    --no-sentinel) SENTINEL=""; shift ;;
    *) echo "ERROR: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

port_holders() { lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }

# 1) Reap whatever holds the port (by port, not ancestry — kills orphans too).
for pid in $(port_holders); do
  echo "  reaping :$PORT holder pid $pid"
  kill -9 "$pid" 2>/dev/null || true
done

# 2) Wait (≤5s) for the port to actually free.
for _ in $(seq 1 10); do
  [ -z "$(port_holders)" ] && break
  sleep 0.5
done
if [ -n "$(port_holders)" ]; then
  echo "ERROR: :$PORT still held after kill — cannot guarantee a fresh bot" >&2
  exit 1
fi

# 3) Start fresh. (run-tester-bot.sh's own readiness print is best-effort; we
#    do the load-bearing checks below.)
"$ROOT/scripts/run-tester-bot.sh"

# 4) Assert a listener exists (≤20s) — a crashed start leaves the port empty.
pid=""
for _ in $(seq 1 20); do
  pid="$(port_holders | head -1)"
  [ -n "$pid" ] && break
  sleep 1
done
if [ -z "$pid" ]; then
  echo "ERROR: no listener on :$PORT after start — bot failed to launch (see /tmp/hermescraft/bot-tester.log)" >&2
  exit 1
fi

# 5) Assert it's actually connected to the MC server.
connected=""
for _ in $(seq 1 25); do
  connected="$(curl -sf "http://localhost:$PORT/health" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected'))" 2>/dev/null || echo "")"
  [ "$connected" = "True" ] && break
  sleep 1
done
if [ "$connected" != "True" ]; then
  echo "ERROR: bot on :$PORT (pid $pid) never reported connected:True" >&2
  exit 1
fi

# 6) Optional sentinel: prove the CURRENT code is loaded by exercising an action.
if [ -n "$SENTINEL" ]; then
  ok="$(curl -sf -X POST "http://localhost:$PORT/action/$SENTINEL" \
    -H 'content-type: application/json' -d '{}' 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))" 2>/dev/null || echo "")"
  if [ "$ok" != "True" ]; then
    echo "ERROR: sentinel action '$SENTINEL' did not return ok:true — running bot may be stale code" >&2
    exit 1
  fi
fi

echo "✓ verified fresh Tester: pid $pid on :$PORT, connected, sentinel '$SENTINEL' ok"
