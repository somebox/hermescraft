#!/usr/bin/env bash
# Shared defaults for scenario agent-test wrappers (aligned with W5/W6 worker policy).
#
# Proc-nav harness (Phase B/D agent-test):
#   export BOT_URL=http://127.0.0.1:3007 MC_USERNAME=Mox PROC_WORLD=proc-nav
#   AGENT_SPEC=data/agent-tests/topics/scouting/overlook-survey-proc-nav.yaml \
#     scripts/scenario-agent-test.sh scouting.overlook
SCENARIO_DEFAULT_BOT_URL="${BOT_URL:-http://localhost:3001}"
SCENARIO_DEFAULT_MC_USERNAME="${MC_USERNAME:-}"
SCENARIO_DEFAULT_MODEL="${AGENT_TEST_MODEL:-deepseek/deepseek-v4-flash:exacto}"

# Merge wrapper defaults with user args after `--`. User wins on duplicate flags.
# Usage: scenario_merge_agent_args "$@"   # after optional `--` consumed by caller
scenario_merge_agent_args() {
  local -a user=("$@")
  local PY="${SCENARIO_PY:-python3}"
  "$PY" - <<'PY' "${SCENARIO_DEFAULT_BOT_URL}" "${SCENARIO_DEFAULT_MODEL}" "${user[@]}"
import sys

def parse_flags(argv):
    out = {}
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok in ("--bot-url", "--model", "--max-turns") and i + 1 < len(argv):
            out[tok] = argv[i + 1]
            i += 2
            continue
        i += 1
    return out

bot_d, model_d = sys.argv[1], sys.argv[2]
user = sys.argv[3:]
merged = parse_flags(user)
if "--bot-url" not in merged:
    merged = {"--bot-url": bot_d, **merged}
if "--model" not in merged:
    merged = {"--model": model_d, **merged}
# Preserve user arg order for unknown flags; emit known first for readability
rest = []
i = 0
while i < len(user):
    tok = user[i]
    if tok in ("--bot-url", "--model", "--max-turns"):
        i += 2
        continue
    rest.append(tok)
    i += 1
for k in ("--bot-url", "--model", "--max-turns"):
    if k in merged:
        print(k)
        print(merged[k])
for t in rest:
    print(t)
PY
}

# Poll /health (and one POST /connect) like landfolk-control wait_for_bot_connected.
scenario_require_bot_listener() {
  local url="${1:-$SCENARIO_DEFAULT_BOT_URL}"
  local timeout="${SCENARIO_BOT_CONNECT_TIMEOUT_S:-90}"
  local waited=0
  local posted=false
  echo "== bot listener $url (timeout ${timeout}s) =="
  while [[ "$waited" -lt "$timeout" ]]; do
    local connected
    connected="$(curl -sf "${url}/health" 2>/dev/null | "$SCENARIO_PY" -c "import sys,json; print(str(json.load(sys.stdin).get('connected', False)).lower())" 2>/dev/null || echo "false")"
    if [[ "$connected" == "true" ]]; then
      echo "bot connected"
      return 0
    fi
    if [[ "$posted" == "false" ]] && curl -sf "${url}/health" >/dev/null 2>&1; then
      posted=true
      curl -sf -X POST "${url}/connect" >/dev/null 2>&1 || true
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "ERROR: bot not connected at $url — run landfolk start (or your bench Flint launch) first." >&2
  return 1
}
