#!/usr/bin/env bash
# Capstone pre-trial gate.
#
# Runs every check that must pass before the live trial (Session 5b)
# is allowed to start. Honours the plan's freeze rule: any missing
# precondition causes a non-zero exit with a named cause, rather than
# letting the trial limp forward.
#
# Usage:
#   prototypes/agent-arch/capstone/preflight.sh
#
# Checks (each prints OK / MISSING and a hint):
#   1. PyYAML + pytest available in the repo .venv
#   2. data/bots/mox.yaml present (the wheat epic binds to mox)
#   3. Referenced skill bundles exist for all four execute assignees
#      — flags agent-builder, agent-farmer, agent-crafter as gaps
#      because those don't exist in the repo today.
#   4. Tester bot reachable on its conventional port (3004) — `mc verify`
#      runs there.
#   5. Current `mc verify` supports the predicate the default graph
#      asks for (chest_contains).
#   6. Proto HERMES_HOME exists.
#   7. Scaffold unit tests pass.
#
# Exit codes:
#   0  — all green, trial may proceed.
#   1  — at least one gap. Read stdout for the named cause.
#   64 — usage error.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OK=$'\033[32mOK\033[0m'
MISS=$'\033[31mMISSING\033[0m'
WARN=$'\033[33mWARN\033[0m'
fail=0

say() { printf '  %s  %s\n' "$1" "$2"; }
header() { printf '\n== %s ==\n' "$1"; }

header "1. Python deps in repo .venv"
VENV_PY="$REPO_ROOT/.venv/bin/python"
if [[ -x "$VENV_PY" ]]; then
  if "$VENV_PY" -c 'import yaml, pytest' >/dev/null 2>&1; then
    say "$OK" "yaml + pytest importable"
  else
    say "$MISS" "yaml or pytest missing — install in $REPO_ROOT/.venv"
    fail=1
  fi
else
  say "$MISS" "$VENV_PY not executable — run repo's venv bootstrap"
  fail=1
fi

header "2. Bot registry has mox"
if [[ -f "$REPO_ROOT/data/bots/mox.yaml" ]]; then
  port=$(awk '/^api_port:/ {print $2}' "$REPO_ROOT/data/bots/mox.yaml")
  user=$(awk '/^username:/ {print $2}' "$REPO_ROOT/data/bots/mox.yaml")
  say "$OK" "data/bots/mox.yaml port=${port:-?} user=${user:-?}"
else
  say "$MISS" "data/bots/mox.yaml — required by the wheat epic"
  fail=1
fi

header "3. Skill bundles for execute assignees"
declare -A required_bundles=(
  [navigator]="agent-navigator minecraft-navigation minecraft-survival"
  [builder]="agent-builder minecraft-building minecraft-survival"
  [farmer]="agent-farmer minecraft-farming minecraft-survival"
  [crafter]="agent-crafter minecraft-chores minecraft-survival"
)
for assignee in navigator builder farmer crafter; do
  missing_for_assignee=""
  for skill in ${required_bundles[$assignee]}; do
    if [[ ! -f "$REPO_ROOT/skills/$skill.md" ]]; then
      missing_for_assignee="$missing_for_assignee $skill"
    fi
  done
  if [[ -z "$missing_for_assignee" ]]; then
    say "$OK" "$assignee bundle complete"
  else
    say "$MISS" "$assignee missing:$missing_for_assignee"
    fail=1
  fi
done

header "4. Tester bot reachable (mc verify target)"
TESTER_URL="${MC_TESTER_URL:-http://127.0.0.1:3004}"
if curl -sf "$TESTER_URL/status?lean=true" >/dev/null 2>&1; then
  say "$OK" "Tester answering at $TESTER_URL"
else
  say "$WARN" "Tester not answering at $TESTER_URL — start with scripts/run-tester-bot.sh before the trial"
  # WARN, not fail: scaffold doesn't need Tester; trial does.
fi

header "4b. Colony bots (mox + pip + zee) — trial only"
if [[ -x "$REPO_ROOT/scripts/colony" ]]; then
  # `colony status` doesn't fail if bots are down — it reports them.
  # The MISSING line surfaces a bot whose registry yaml is broken;
  # that IS a fail (script can't launch what it can't parse).
  if "$REPO_ROOT/scripts/colony" status --json 2>/dev/null \
        | python3 -c "import json,sys;d=json.load(sys.stdin);
errs=[b for b in d if b['status']=='registry-error']
sys.exit(1 if errs else 0)" 2>/dev/null; then
    up_count=$("$REPO_ROOT/scripts/colony" status --json 2>/dev/null \
        | python3 -c "import json,sys;d=json.load(sys.stdin); print(sum(1 for b in d if b['status']=='up'))")
    total=$("$REPO_ROOT/scripts/colony" status --json 2>/dev/null \
        | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
    if [[ "$up_count" == "$total" ]]; then
      say "$OK" "all $total colony bots up"
    else
      say "$WARN" "$up_count/$total colony bots up — bring rest up with: scripts/colony start --all"
    fi
  else
    say "$MISS" "registry-error in scripts/colony status — broken yaml under data/bots/"
    fail=1
  fi
else
  say "$MISS" "scripts/colony missing or not executable"
  fail=1
fi

header "5. mc verify supports the default-graph predicate"
if "$VENV_PY" - <<'PY' 2>/dev/null
import sys
from pathlib import Path
root = Path.cwd()
sys.path.insert(0, str(root / "prototypes" / "agent-arch"))
from capstone.acceptance import SUPPORTED_KINDS
from capstone.wheat_graph import build_default_graph
g = build_default_graph()
kind = (g.acceptance_predicate or {}).get("kind", "")
if kind not in SUPPORTED_KINDS:
    print(f"unsupported predicate: {kind}")
    sys.exit(1)
PY
then
  say "$OK" "default graph predicate supported by current mc verify"
else
  say "$MISS" "default graph predicate exceeds mc verify capability — extend verify.js or narrow predicate"
  fail=1
fi

header "6. Proto HERMES_HOME"
PROTO_HOME="${HERMES_HOME:-$HOME/.hermes-proto-agent-arch}"
if [[ -d "$PROTO_HOME" ]]; then
  say "$OK" "$PROTO_HOME exists"
else
  say "$WARN" "$PROTO_HOME does not exist — proto setup.sh hasn't been run yet"
  # WARN: trial-only; scaffold tests don't need it.
fi

header "7. Scaffold unit tests"
if "$VENV_PY" -m pytest \
     "$REPO_ROOT/prototypes/agent-arch/tests/test_capstone_scaffold.py" \
     -q --tb=line >/dev/null 2>&1; then
  say "$OK" "test_capstone_scaffold.py green"
else
  say "$MISS" "scaffold tests failing — rerun with -v for the cause"
  fail=1
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "preflight: all gates passed (WARNs are trial-only)."
  exit 0
else
  echo "preflight: at least one gate FAILED — see lines marked MISSING above."
  echo "Per the freeze rule, do NOT start the trial until each gap is filed and closed."
  exit 1
fi
