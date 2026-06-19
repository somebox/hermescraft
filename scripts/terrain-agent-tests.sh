#!/usr/bin/env bash
# Run embodied terrain-shaping agent tests (F_*). Uses Tester on :3004 + landfolk-test rcon.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BOT_URL="${BOT_URL:-http://localhost:3004}"
export MC_USERNAME="${MC_USERNAME:-Tester}"

ensure_tester() {
  if curl -sf "$BOT_URL/health" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get('connected') and str(d.get('username','')).lower()=='tester' else 1)" 2>/dev/null; then
    echo "Tester connected at $BOT_URL"
    return 0
  fi
  echo "Starting Tester (see /tmp/hermescraft/bot-tester.log)…"
  "$ROOT/scripts/run-tester-bot.sh" >/dev/null 2>&1 || {
    echo "ERROR: run-tester-bot.sh failed" >&2
    exit 1
  }
  for _ in $(seq 1 30); do
    if curl -sf "$BOT_URL/health" 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); raise SystemExit(0 if d.get('connected') else 1)" 2>/dev/null; then
      echo "Tester ready at $BOT_URL"
      return 0
    fi
    sleep 1
  done
  echo "ERROR: Tester did not become ready on $BOT_URL" >&2
  exit 1
}

run_spec() {
  python3 scripts/agent-test.py --bot-url "$BOT_URL" "$1"
}

SPECS=(
  data/agent-tests/F_deck_gap_reach.yaml
  data/agent-tests/F_river_cobble_ford.yaml
  data/agent-tests/F_walkable_step_down.yaml
  data/agent-tests/F_two_block_lip_ramp.yaml
  data/agent-tests/F_chasm_bridge_reach.yaml
  data/agent-tests/F_base_apron_no_damage.yaml
)

usage() {
  echo "Usage: $0 [all|retry|list|<spec.yaml>|--help]"
  echo "  all   — run terrain F_* suite in order"
  echo "  retry — re-run the four specs that failed in the last embodied pass"
  echo "  list  — print spec paths"
  exit "${1:-0}"
}

cmd="${1:-all}"
case "$cmd" in
  --help|-h) usage 0 ;;
  list)
    printf '%s\n' "${SPECS[@]}"
    exit 0
    ;;
  retry|failures)
    ensure_tester
    FAIL_SPECS=(
      data/agent-tests/F_walkable_step_down.yaml
      data/agent-tests/F_two_block_lip_ramp.yaml
      data/agent-tests/F_chasm_bridge_reach.yaml
      data/agent-tests/F_base_apron_no_damage.yaml
    )
    failed=0
    for spec in "${FAIL_SPECS[@]}"; do
      echo "▶ python3 scripts/agent-test.py --bot-url $BOT_URL $spec"
      if ! run_spec "$spec"; then
        failed=$((failed + 1))
      fi
    done
    echo ""
    echo "Terrain retries: $(( ${#FAIL_SPECS[@]} - failed ))/${#FAIL_SPECS[@]} passed"
    exit "$(( failed > 0 ? 1 : 0 ))"
    ;;
  all)
    ensure_tester
    failed=0
    for spec in "${SPECS[@]}"; do
      echo "▶ python3 scripts/agent-test.py --bot-url $BOT_URL $spec"
      if ! run_spec "$spec"; then
        failed=$((failed + 1))
      fi
    done
    echo ""
    echo "Terrain agent tests: $(( ${#SPECS[@]} - failed ))/${#SPECS[@]} passed"
    exit "$(( failed > 0 ? 1 : 0 ))"
    ;;
  *)
    ensure_tester
    exec python3 scripts/agent-test.py --bot-url "$BOT_URL" "$cmd"
    ;;
esac
