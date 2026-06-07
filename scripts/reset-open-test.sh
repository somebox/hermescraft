#!/usr/bin/env bash
# reset-open-test.sh — bring the two-bot demo arena back to a known
# starting state.
#
# Flow:
#   1. If bots are up, run fixture cleanup (drops marks, clears blocks).
#   2. Stop colony bots.
#   3. Start colony bots fresh (health-checks each).
#   4. Run fixture prep (stages blocks, /tp bots into landfolk-test,
#      POSTs marks to all three bots' HTTP APIs).
#   5. Run preflight; non-zero exit on any MISSING.
#   6. Echo the recommended trial command.
#
# Tester (:3004) is assumed to be running independently (started by
# scripts/run-tester-bot.sh). Marks POST to Tester too because the final
# `mc verify at_mark seed --block oak_sign` will be queried against it.
#
# Usage:
#   scripts/reset-open-test.sh                # full reset (default)
#   scripts/reset-open-test.sh --soft         # restart bots only, skip
#                                             # fixture cleanup+prep
#
# Env overrides (passed through to scripts/colony and the fixture):
#   MC_HOST, MC_PORT, MC_HOST_SSH, MC_DOCKER_NAME, COLONY_LOG_DIR

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FIXTURE="$REPO_ROOT/data/test-fixtures/open/two_bot_base.yaml"
COLONY="$SCRIPT_DIR/colony"
RUN_FIXTURE="$SCRIPT_DIR/run-fixture.sh"
PREFLIGHT="$REPO_ROOT/prototypes/agent-arch/capstone/preflight.sh"

MODE="full"
for arg in "$@"; do
  case "$arg" in
    --soft) MODE="soft" ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "reset-open-test: unknown arg: $arg" >&2; exit 64 ;;
  esac
done

# ── Preconditions ───────────────────────────────────────────────────
for f in "$FIXTURE" "$COLONY" "$RUN_FIXTURE" "$PREFLIGHT"; do
  if [[ ! -x "$f" && ! -f "$f" ]]; then
    echo "reset-open-test: missing $f" >&2
    exit 66
  fi
done

bots_up() {
  # Return 0 if colony status reports any bot up; 1 otherwise.
  "$COLONY" status --json 2>/dev/null \
    | python3 -c "import json, sys; sys.exit(0 if any(b['status']=='up' for b in json.load(sys.stdin)) else 1)" \
    2>/dev/null
}

# ── 1. Fixture cleanup (only if bots are currently up) ──────────────
if [[ "$MODE" == "full" ]]; then
  if bots_up; then
    echo "── fixture cleanup (bots are up) ──"
    "$RUN_FIXTURE" cleanup "$FIXTURE" || echo "  (cleanup had errors; continuing)"
  else
    echo "── fixture cleanup: skipped (bots are down — nothing to clean from HTTP side) ──"
  fi
fi

# ── 2. Stop colony bots ─────────────────────────────────────────────
echo "── stopping colony bots ──"
"$COLONY" stop --all || true

# ── 3. Start colony bots ────────────────────────────────────────────
echo "── starting colony bots ──"
if ! "$COLONY" start --all; then
  echo "reset-open-test: colony start --all reported failures" >&2
  echo "Check $COLONY_LOG_DIR/bot-*.log for the cause." >&2
  exit 1
fi

# ── 4. Fixture prep ─────────────────────────────────────────────────
if [[ "$MODE" == "full" ]]; then
  echo "── fixture prep (staging blocks + marks + tp bots) ──"
  if ! "$RUN_FIXTURE" prep "$FIXTURE"; then
    echo "reset-open-test: fixture prep failed" >&2
    exit 1
  fi
else
  echo "── fixture prep skipped (--soft) ──"
fi

# ── 5. Preflight ────────────────────────────────────────────────────
echo "── preflight ──"
if ! "$PREFLIGHT"; then
  echo "reset-open-test: preflight reported MISSING — see above" >&2
  exit 1
fi

# ── 6. Trial-ready summary ──────────────────────────────────────────
echo
echo "ready. recommended next command:"
echo "  HERMES_HOME=~/.hermes-proto-agent-arch python \\"
echo "    prototypes/agent-arch/capstone/run_two_bot_base.py \\"
echo "    --run-id trial-\$(date +%s) --watch"
