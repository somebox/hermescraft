#!/usr/bin/env bash
# Canonical test runner for hermescraft. Ensures the right setup:
#
#   - Bot Node tests (bot/test/**/*.test.js) — always safe, no MC needed
#   - Python unit tests (tests/unit) — safe, no MC needed
#   - Python functional tests (tests/functional) — needs:
#       * Tester bot on port 3004 (NOT Steve on 3001!)
#       * Tester in dimension landfolk-test (mvtp)
#       * Steve untouched (production circuit bot stays where it is)
#   - Python integration tests (tests/integration) — needs all of the above
#     PLUS an LLM key (skipped by default to avoid token burn).
#
# Why this exists: in past runs we accidentally pointed pytest at Steve
# (port 3001) in the production landfolk world. Tests TP'd Steve around,
# wiped his inventory, and broke the active circuit-v6 run. This script
# prevents that by enforcing the test-bot identity + arena.
#
# Usage:
#   ./scripts/run-tests.sh                    # bot tests + python unit + functional
#   ./scripts/run-tests.sh --bot              # just bot/test (no MC needed)
#   ./scripts/run-tests.sh --unit             # bot tests + python unit (no MC)
#   ./scripts/run-tests.sh --functional       # bot tests + python unit + functional (needs MC + Tester)
#   ./scripts/run-tests.sh --integration      # all + integration (needs LLM key)
#   ./scripts/run-tests.sh --no-bot           # skip bot/test (when iterating on python only)
#   ./scripts/run-tests.sh --keep-bot         # don't restart Tester if already running

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="${LOG_DIR:-/tmp/hermescraft}"
mkdir -p "$LOG_DIR"

# ── Parse args ───────────────────────────────────────────────────────────
RUN_BOT=1
RUN_UNIT=1
RUN_FUNCTIONAL=1
RUN_INTEGRATION=0
KEEP_TESTER=0

if [[ $# -eq 0 ]]; then
  : # defaults: bot + unit + functional
else
  case "${1:-}" in
    --bot)         RUN_BOT=1; RUN_UNIT=0; RUN_FUNCTIONAL=0; RUN_INTEGRATION=0 ;;
    --unit)        RUN_BOT=1; RUN_UNIT=1; RUN_FUNCTIONAL=0; RUN_INTEGRATION=0 ;;
    --functional)  RUN_BOT=1; RUN_UNIT=1; RUN_FUNCTIONAL=1; RUN_INTEGRATION=0 ;;
    --integration) RUN_BOT=1; RUN_UNIT=1; RUN_FUNCTIONAL=1; RUN_INTEGRATION=1 ;;
    --no-bot)      RUN_BOT=0 ;;
    --keep-bot)    KEEP_TESTER=1 ;;
    --help|-h)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag: $1" >&2
      echo "Run --help for usage" >&2
      exit 2
      ;;
  esac
fi
# Allow combining --keep-bot with other modes (process remaining args).
for arg in "$@"; do
  [[ "$arg" == "--keep-bot" ]] && KEEP_TESTER=1
done

# ── Bot Node tests ───────────────────────────────────────────────────────
if [[ $RUN_BOT -eq 1 ]]; then
  echo "── bot/test: Node unit + integration ──"
  (cd "$SCRIPT_DIR/bot" && node --test 'test/**/*.test.js')
  echo ""
fi

# Early-out if only bot tests were requested.
if [[ $RUN_UNIT -eq 0 && $RUN_FUNCTIONAL -eq 0 && $RUN_INTEGRATION -eq 0 ]]; then
  echo "✓ All requested tests passed."
  exit 0
fi

# ── Python unit (no MC needed) ───────────────────────────────────────────
if [[ $RUN_UNIT -eq 1 ]]; then
  echo "── tests/unit: pure python, no MC ──"
  .venv/bin/pytest -m unit --tb=line -q
  echo ""
fi

# Early-out if MC-bound tests aren't needed.
if [[ $RUN_FUNCTIONAL -eq 0 && $RUN_INTEGRATION -eq 0 ]]; then
  echo "✓ All requested tests passed."
  exit 0
fi

# ── Tester bot setup (functional + integration both need this) ────────────
echo "── Tester bot setup ──"

# Is Tester already up on 3004?
tester_up=0
if curl -sf "http://localhost:3004/health" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get('connected') and d.get('username','').lower()=='tester' else 1)" 2>/dev/null; then
  tester_up=1
  echo "  Tester is already up on :3004 (--keep-bot$( [[ $KEEP_TESTER -eq 0 ]] && echo ' would have skipped restart anyway' ))"
fi

if [[ $tester_up -eq 0 || $KEEP_TESTER -eq 0 ]]; then
  if [[ $tester_up -eq 1 ]]; then
    echo "  Restarting Tester (fresh state) — use --keep-bot to skip"
  else
    echo "  Starting Tester (not running)"
  fi
  "$SCRIPT_DIR/scripts/run-tester-bot.sh" >/dev/null 2>&1 || {
    echo "ERROR: run-tester-bot.sh failed; see $LOG_DIR/bot-tester.log" >&2
    exit 1
  }
fi

# Confirm Tester (not some other bot) is at :3004.
echo "── Verify Tester identity ──"
identity=$(curl -sf http://localhost:3004/health 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('username','?'),d.get('connected'))" 2>/dev/null || echo "? False")
case "$identity" in
  Tester*True*) echo "  ✓ Tester connected on :3004" ;;
  *)
    echo "ERROR: expected 'Tester True' on :3004; got '$identity'" >&2
    echo "       This is the safety check that prevents pytest from driving Steve." >&2
    exit 1
    ;;
esac

# ── Reset arena: mvtp Tester into landfolk-test ──────────────────────────
echo "── Reset arena (mvtp Tester → landfolk-test) ──"
RCON='ssh ubuntu-host sudo docker exec minecraft rcon-cli'
$RCON 'execute in landfolk-test run gamerule keepInventory true' >/dev/null 2>&1 || true
$RCON 'execute in landfolk-test run spawnpoint Tester 52 65 52' >/dev/null 2>&1 || true
$RCON 'mvtp Tester landfolk-test' >/dev/null 2>&1 || $RCON 'tp Tester 52 65 52' >/dev/null 2>&1
sleep 1
# Bot might need a moment to settle in the new world.
sleep 1

# Sanity: confirm Tester is actually in landfolk-test now.
tester_pos=$(curl -sf http://localhost:3004/status 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',{}); p=d.get('position'); print(f\"{p['x']:.0f},{p['y']},{p['z']:.0f}\")" 2>/dev/null || echo "?,?,?")
echo "  Tester at $tester_pos (expected ~52,65,52 in landfolk-test)"

# Steve safety: make absolutely sure we haven't somehow flipped to him.
if curl -sf http://localhost:3001/health 2>/dev/null | grep -q '"username":"Steve"'; then
  echo "  ✓ Steve (production circuit bot) still on :3001, untouched"
fi

# ── Python functional ────────────────────────────────────────────────────
if [[ $RUN_FUNCTIONAL -eq 1 ]]; then
  echo ""
  echo "── tests/functional: pytest -m functional ──"
  .venv/bin/pytest -m functional --tb=line -q
  echo ""
fi

# ── Python integration ──────────────────────────────────────────────────
if [[ $RUN_INTEGRATION -eq 1 ]]; then
  echo "── tests/integration: pytest -m integration (uses LLM key, billable) ──"
  if [[ -z "${OPENROUTER_API_KEY:-}" && -z "$(grep -E 'openrouter_api_key' "$SCRIPT_DIR/secrets.yaml" 2>/dev/null)" ]]; then
    echo "ERROR: no OPENROUTER_API_KEY; integration tests need one" >&2
    exit 1
  fi
  .venv/bin/pytest -m integration --tb=line -q
fi

echo ""
echo "✓ All requested tests passed."
