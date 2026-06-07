#!/usr/bin/env bash
# Trial-time preflight for the wheat-farm capstone (Session 5b).
#
# Runs AFTER the wheat_capstone.yaml fixture is applied. Confirms
# everything the trial needs is staged in vivo:
#
#   1. Mox bot HTTP API reachable on :3007.
#   2. Mox positioned inside the plot footprint (-55..-45 x, 45..55 z)
#      at Y=65 (above the dirt floor at Y=64).
#   3. Mox inventory contains wooden_hoe + 64 wheat_seeds.
#   4. All three marks present and at expected coords:
#      field_south (-50, 64, 50), chest_food (-50, 65, 60),
#      base_anchor (-55, 65, 50).
#   5. Water source block at the field center (Y=64).
#   6. Chest block at chest_food location (Y=65).
#   7. Tester bot reachable on :3004 (needed for acceptance verify).
#   8. pilot-mox profile exists in live HERMES_HOME.
#   9. wheat-capstone board exists in live HERMES_HOME.
#
# Each check prints OK / MISSING. Exit 0 if all green; 1 otherwise.
#
# Usage:
#   scripts/preflight-wheat.sh
#
# Env:
#   HERMES_HOME (defaults to ~/.hermes; the dashboard-visible install)
#   MC_HOST_SSH (defaults to ubuntu-host; where the minecraft container runs)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OK=$'\033[32mOK\033[0m'
MISS=$'\033[31mMISSING\033[0m'
fail=0

say() { printf '  %s  %s\n' "$1" "$2"; }
header() { printf '\n== %s ==\n' "$1"; }

MOX_URL="${MOX_URL:-http://127.0.0.1:3007}"
TESTER_URL="${TESTER_URL:-http://127.0.0.1:3004}"
HERMES_HOME_LIVE="${HERMES_HOME:-$HOME/.hermes}"
MC_HOST_SSH="${MC_HOST_SSH:-ubuntu-host}"
MC_DOCKER_NAME="${MC_DOCKER_NAME:-minecraft}"

header "1. Mox bot HTTP"
if curl -sf "$MOX_URL/status?lean=true" >/dev/null 2>&1; then
  say "$OK" "Mox answering at $MOX_URL"
else
  say "$MISS" "Mox not answering at $MOX_URL — start with scripts/colony start mox"
  fail=1
fi

header "2. Mox position (inside plot footprint)"
# /status returns {ok, data: {position: {x,y,z,...}, ...}}.
status_json=$(curl -sf "$MOX_URL/status" 2>/dev/null)
pos_x=$(echo "$status_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('position',{}).get('x',''))" 2>/dev/null)
pos_y=$(echo "$status_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('position',{}).get('y',''))" 2>/dev/null)
pos_z=$(echo "$status_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('position',{}).get('z',''))" 2>/dev/null)
if [[ -z "$pos_x" || -z "$pos_y" || -z "$pos_z" ]]; then
  say "$MISS" "could not read Mox position (entity endpoint silent)"
  fail=1
else
  # Plot footprint: x in [-55, -45], z in [45, 55], y >= 65 (or 64+small).
  on_pad=$(python3 -c "
x, y, z = ${pos_x:-0}, ${pos_y:-0}, ${pos_z:-0}
in_x = -55.5 <= x <= -44.5
in_z = 44.5 <= z <= 55.5
above_floor = y >= 64.5
print('yes' if (in_x and in_z and above_floor) else 'no')
")
  if [[ "$on_pad" == "yes" ]]; then
    say "$OK" "Mox at ($pos_x, $pos_y, $pos_z) inside plot footprint"
  else
    say "$MISS" "Mox at ($pos_x, $pos_y, $pos_z) NOT on the plot (expected x: -55..-45, z: 45..55, y >= 65). Re-run fixture prep or check tp target."
    fail=1
  fi
fi

header "3. Mox inventory (wooden_hoe + 64 wheat_seeds)"
inv_check=$(curl -sf "$MOX_URL/inventory" 2>/dev/null \
  | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print(f'parse:{e}')
    sys.exit()
cats = d.get('data', {}).get('categories', {})
items = []
for cat, lst in cats.items():
    for it in lst:
        items.append((it.get('name'), it.get('count', 0)))
hoe = next((c for n, c in items if n == 'wooden_hoe'), 0)
seeds = next((c for n, c in items if n == 'wheat_seeds'), 0)
print(f'hoe={hoe} seeds={seeds}')
")
if [[ "$inv_check" =~ ^hoe=1\ seeds=6[0-9]$ ]]; then
  say "$OK" "$inv_check"
else
  say "$MISS" "inventory check: $inv_check (expected hoe=1 seeds=64)"
  fail=1
fi

header "4. Marks present (wheat_plot, wheat_chest, wheat_start)"
# Marks are POSTed by the fixture to BOTH bots — Mox for navigation
# AND Tester for `mc verify`. Preflight checks Tester since that's
# where `mc verify` reads; the validator (run during fixture prep)
# checks both.
marks_json=$(curl -sf "$TESTER_URL/marks" 2>/dev/null)
expected_marks=("wheat_plot:-50,64,50" "wheat_chest:-50,65,60" "wheat_start:-55,65,50")
for spec in "${expected_marks[@]}"; do
  name="${spec%%:*}"
  coords="${spec##*:}"
  ex_x="${coords%%,*}"; rest="${coords#*,}"
  ex_y="${rest%%,*}";  ex_z="${rest##*,}"
  found=$(echo "$marks_json" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('no')
    sys.exit()
for m in d.get('data', {}).get('marks', []):
    if m.get('name') == '$name':
        x, y, z = m.get('x'), m.get('y'), m.get('z')
        if x == $ex_x and y == $ex_y and z == $ex_z:
            print('yes')
            sys.exit()
        else:
            print(f'wrong-coord:({x},{y},{z})')
            sys.exit()
print('absent')
")
  if [[ "$found" == "yes" ]]; then
    say "$OK" "mark $name at ($ex_x, $ex_y, $ex_z)"
  else
    say "$MISS" "mark $name: $found (expected $ex_x, $ex_y, $ex_z) — re-run fixture prep"
    fail=1
  fi
done

header "5+6. World blocks (water + chest via rcon)"
# `execute if block X Y Z minecraft:<id>` (without `run`) returns
# "Test passed" / "Test failed" on stdout — straightforward to gate on.
if command -v ssh >/dev/null 2>&1; then
  water_check=$(ssh -n -o BatchMode=yes "$MC_HOST_SSH" \
    "sudo docker exec $MC_DOCKER_NAME rcon-cli 'execute in landfolk-test if block -50 64 50 minecraft:water'" \
    2>&1 | head -1)
  if [[ "$water_check" == *"Test passed"* ]]; then
    say "$OK" "water source at (-50, 64, 50)"
  else
    say "$MISS" "no water source at field center — rcon: ${water_check:0:120}"
    fail=1
  fi

  chest_check=$(ssh -n -o BatchMode=yes "$MC_HOST_SSH" \
    "sudo docker exec $MC_DOCKER_NAME rcon-cli 'execute in landfolk-test if block -50 65 60 minecraft:chest'" \
    2>&1 | head -1)
  if [[ "$chest_check" == *"Test passed"* ]]; then
    say "$OK" "chest at (-50, 65, 60)"
  else
    say "$MISS" "no chest at chest_food coords — rcon: ${chest_check:0:120}"
    fail=1
  fi
else
  say "$MISS" "ssh not available — cannot rcon-verify water/chest"
  fail=1
fi

header "7. Tester bot (acceptance verify target)"
if curl -sf "$TESTER_URL/status?lean=true" >/dev/null 2>&1; then
  say "$OK" "Tester at $TESTER_URL"
else
  say "$MISS" "Tester not at $TESTER_URL — start with scripts/run-tester-bot.sh"
  fail=1
fi

header "8. Live HERMES_HOME + pilot-mox profile"
if [[ -d "$HERMES_HOME_LIVE/profiles/pilot-mox" ]]; then
  say "$OK" "pilot-mox in $HERMES_HOME_LIVE/profiles/"
else
  say "$MISS" "pilot-mox missing from $HERMES_HOME_LIVE/profiles/ — run prototypes/agent-arch/setup-pilot-mox-live.sh"
  fail=1
fi

header "9. wheat-capstone board"
if HERMES_HOME="$HERMES_HOME_LIVE" hermes kanban boards list 2>/dev/null \
     | grep -qE 'wheat-capstone'; then
  say "$OK" "board wheat-capstone exists in $HERMES_HOME_LIVE"
else
  say "$MISS" "no wheat-capstone board — runner will create on first --create-only"
  # not a fail: runner creates idempotently
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "preflight-wheat: all gates passed. Launch:"
  echo "  HERMES_HOME=$HERMES_HOME_LIVE \\"
  echo "    python prototypes/agent-arch/capstone/run_wheat_capstone.py \\"
  echo "    --run-id trial-\$(date +%s) --board wheat-capstone --assignee pilot-mox --watch"
  exit 0
else
  echo "preflight-wheat: at least one gate FAILED — fix and re-run before trial."
  exit 1
fi
