#!/usr/bin/env bash
# Bench helpers for proc-lab scenario runs (status, reuse, logs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/scenario-agent-common.sh
source "$ROOT/scripts/scenario-agent-common.sh"
SCENARIO_PY="${ROOT}/.venv/bin/python"
if [[ ! -x "$SCENARIO_PY" ]]; then SCENARIO_PY=python3; fi
export SCENARIO_PY
PY="$SCENARIO_PY"
SERVER="${SERVER:-server.local.yaml}"
RUNTIME="$ROOT/data/runtime"

cmd="${1:-help}"
shift || true

case "$cmd" in
  status)
    echo "== proc-lab state file =="
    if [[ -f "$RUNTIME/proc-lab-state.json" ]]; then
      cat "$RUNTIME/proc-lab-state.json"
    else
      echo "(no state — full materialize on next try)"
    fi
    echo ""
    echo "== last scenario map =="
    if [[ -f "$RUNTIME/last-scenario-map.json" ]]; then
      "$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print('seed',d.get('seed'),'placements',list((d.get('placements')or{}).keys()))" "$RUNTIME/last-scenario-map.json"
    else
      echo "(none)"
    fi
    ;;
  agent-only)
    VARIANT="${VARIANT:-building.flat_pad}"
    AGENT_SPEC="$("$PY" -c "
from mapcatalog.scenario_registry import load_registry, variant_by_id
v = variant_by_id(load_registry(), '$VARIANT')
print(v.agent_test_ref if v and v.agent_test_ref else '')
")"
    export MATERIALIZE=0
    export AUTO_REUSE=0
    if [[ ! -f "$RUNTIME/last-scenario-map.json" ]]; then
      echo "No $RUNTIME/last-scenario-map.json — run scenario-agent-test.sh first." >&2
      exit 1
    fi
    scenario_require_bot_listener "${BOT_URL:-$SCENARIO_DEFAULT_BOT_URL}"
    SPEC_ARG=()
    [[ -n "$AGENT_SPEC" && -f "$AGENT_SPEC" ]] && SPEC_ARG=(--spec "$AGENT_SPEC")
    exec "$PY" scripts/agent-test-from-map.py \
      --map "$RUNTIME/last-scenario-map.json" \
      --variant "$VARIANT" \
      --server "$SERVER" \
      "${SPEC_ARG[@]}" \
      -- "$@"
    ;;
  tail-report)
    TEST_ID="${1:-}"
    DIR="$ROOT/data/agent-tests/runs"
    if [[ -n "$TEST_ID" ]]; then
      f="$(ls -t "$DIR"/${TEST_ID}*.json 2>/dev/null | head -1)"
    else
      f="$(ls -t "$DIR"/*.json 2>/dev/null | grep -v .generated | head -1)"
    fi
    if [[ -z "${f:-}" || ! -f "$f" ]]; then
      echo "No report in $DIR" >&2
      exit 1
    fi
    echo "== $f =="
    "$PY" -c "
import json,sys
r=json.load(open(sys.argv[1]))
print('verdict', r.get('verdict'), 'wall_s', r.get('wall_seconds'))
for p in r.get('predicates') or []:
    mark='✓' if p.get('pass') else '✗'
    print(f\"  {mark} {p.get('kind')}: {p.get('detail','')[:80]}\")
print('--- agent chat (last 1200 chars) ---')
print((r.get('agent_chat') or '')[-1200:])
print('--- mc verbs ---', r.get('metrics',{}).get('mc_verb_counts'))
" "$f"
    ;;
  tail-session)
    SID="${1:-}"
    if [[ -z "$SID" ]]; then
      f="$(ls -t "$ROOT/data/agent-tests/runs"/*.json 2>/dev/null | grep -v .generated | head -1)"
      SID="$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1])).get('hermes_session_id',''))" "$f")"
    fi
    if [[ -z "$SID" ]]; then
      echo "No session id" >&2
      exit 1
    fi
    SESS="$HOME/.hermes/sessions/${SID}.json"
    if [[ ! -f "$SESS" ]]; then
      echo "Missing $SESS" >&2
      exit 1
    fi
    "$PY" -c "
import json,sys
data=json.load(open(sys.argv[1]))
for m in data.get('messages') or data if isinstance(data,list) else []:
    if not isinstance(m,dict): continue
    role=m.get('role','?')
    c=m.get('content')
    if isinstance(c,list):
        for part in c:
            if isinstance(part,dict) and part.get('type')=='text':
                t=part.get('text','')[:400]
                if t.strip(): print(f'[{role}]', t.replace(chr(10),' ')[:400])
    elif isinstance(c,str) and c.strip():
        print(f'[{role}]', c.replace(chr(10),' ')[:400])
" "$SESS"
    ;;
  help|*)
    cat <<'EOF'
Usage: scripts/proc-lab-ops.sh <command> [args]

  status              proc-lab seed state + last scenario map path
  agent-only [-- …]   Re-run agent-test on last map (MATERIALIZE=0)
  tail-report [id]    Latest (or matching) agent-test JSON summary + chat tail
  tail-session [id]   Hermes session messages (id from report if omitted)

Env: SERVER, VARIANT, BOT_URL, AGENT_TEST_MODEL (defaults via scenario-agent-common.sh)

Setup (landfolk parity):
  1. scripts/landfolk start --profiles flint   # or bench Flint on :3002
  2. Full run once: scenario-agent-test.sh …   # materialize + prep (mvtp proc-lab)
  3. Fast loop: proc-lab-ops agent-only -- --bot-url …

Agent-only always runs spec prep (mvtp + tp spawn) even when MATERIALIZE=0.
Do not rely on prior cleanup leaving Flint in proc-lab — cleanup sends him to landfolk-test.
EOF
    ;;
esac
