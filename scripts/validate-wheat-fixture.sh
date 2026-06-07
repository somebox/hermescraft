#!/usr/bin/env bash
# validate-wheat-fixture.sh — assert the wheat capstone arena is staged
# correctly. Called from the prep section of
# data/test-fixtures/colony/wheat_capstone.yaml AFTER all blocks +
# entities are placed.
#
# Exit codes:
#   0  — all assertions pass; safe to launch the trial
#   1  — at least one assertion failed; do NOT launch
#   64 — usage error
#
# Each assertion prints PASS/FAIL with a short context. The script does
# NOT short-circuit on first failure — it runs every check so you see
# the full state of the world in one read, then exits non-zero at the
# end if anything failed.
#
# Geometry comes from constants below — if you change the fixture
# coordinates, change them here too. The fixture YAML pin-points them
# in its header comment.
set -u

OK=$'\033[32mPASS\033[0m'
NO=$'\033[31mFAIL\033[0m'
fail=0

MC_HOST_SSH="${MC_HOST_SSH:-ubuntu-host}"
MC_DOCKER_NAME="${MC_DOCKER_NAME:-minecraft}"
MOX_URL="${MOX_URL:-http://127.0.0.1:3007}"
TESTER_URL="${TESTER_URL:-http://127.0.0.1:3004}"

# Geometry (must match data/test-fixtures/colony/wheat_capstone.yaml)
PAD_X1=-60; PAD_X2=-40
PAD_Z1=43;  PAD_Z2=63
PLOT_X1=-54; PLOT_X2=-46
PLOT_Z1=46;  PLOT_Z2=54
WATER_X=-50; WATER_Y=64; WATER_Z=50
CHEST_X=-50; CHEST_Y=65; CHEST_Z=60
MOX_X=-55;   MOX_Y=65;   MOX_Z=50
FLOOR_Y=64
BEDROCK_Y=59

# ── rcon helpers ────────────────────────────────────────────────────

rcon() {
  # $1 = the part after `execute in landfolk-test ` (no quoting needed)
  ssh -n -o BatchMode=yes "$MC_HOST_SSH" \
    "sudo docker exec $MC_DOCKER_NAME rcon-cli 'execute in landfolk-test $1'" \
    2>&1 | head -1
}

assert_block() {
  local where="$1" x="$2" y="$3" z="$4" block="$5"
  local out
  out=$(rcon "if block $x $y $z minecraft:$block")
  if [[ "$out" == *"Test passed"* ]]; then
    printf '  %s  %s (-> %s)\n' "$OK" "$where" "$block"
  else
    printf '  %s  %s: expected minecraft:%s — rcon: %s\n' "$NO" "$where" "$block" "${out:0:120}" >&2
    fail=1
  fi
}

# ── 1. Pad floor (corners + sampled interior) ───────────────────────
echo "── 1. Pad floor (Y=$FLOOR_Y dirt across $((PAD_X2 - PAD_X1 + 1))×$((PAD_Z2 - PAD_Z1 + 1))) ──"
assert_block "pad NW $PAD_X1,$FLOOR_Y,$PAD_Z1" "$PAD_X1" "$FLOOR_Y" "$PAD_Z1" "dirt"
assert_block "pad NE $PAD_X2,$FLOOR_Y,$PAD_Z1" "$PAD_X2" "$FLOOR_Y" "$PAD_Z1" "dirt"
assert_block "pad SW $PAD_X1,$FLOOR_Y,$PAD_Z2" "$PAD_X1" "$FLOOR_Y" "$PAD_Z2" "dirt"
assert_block "pad SE $PAD_X2,$FLOOR_Y,$PAD_Z2" "$PAD_X2" "$FLOOR_Y" "$PAD_Z2" "dirt"
# Pad center as an interior sample (proves fill landed evenly)
assert_block "pad center -50,$FLOOR_Y,53" -50 "$FLOOR_Y" 53 "dirt"

# ── 2. Plot footprint (9×9 corners + edge midpoints) ────────────────
echo "── 2. Wheat plot footprint ($((PLOT_X2 - PLOT_X1 + 1))×$((PLOT_Z2 - PLOT_Z1 + 1))) ──"
assert_block "plot NW $PLOT_X1,$FLOOR_Y,$PLOT_Z1" "$PLOT_X1" "$FLOOR_Y" "$PLOT_Z1" "dirt"
assert_block "plot NE $PLOT_X2,$FLOOR_Y,$PLOT_Z1" "$PLOT_X2" "$FLOOR_Y" "$PLOT_Z1" "dirt"
assert_block "plot SW $PLOT_X1,$FLOOR_Y,$PLOT_Z2" "$PLOT_X1" "$FLOOR_Y" "$PLOT_Z2" "dirt"
assert_block "plot SE $PLOT_X2,$FLOOR_Y,$PLOT_Z2" "$PLOT_X2" "$FLOOR_Y" "$PLOT_Z2" "dirt"

# ── 3. Water source + walking corridor ──────────────────────────────
echo "── 3. Water source + walking corridor ──"
assert_block "water source $WATER_X,$WATER_Y,$WATER_Z" "$WATER_X" "$WATER_Y" "$WATER_Z" "water"
# Mox starts at -55, plot west edge is -54, so 1-block walk east — no corridor needed.
# Mox -> chest: -50 z=50 to z=60 along x=-50 — sample mid-corridor cells
assert_block "corridor -50,64,55 (plot south edge → chest)" -50 64 55 "dirt"
assert_block "corridor -50,64,57" -50 64 57 "dirt"
assert_block "corridor -50,64,59 (chest north edge)" -50 64 59 "dirt"
# Mox start dirt-block-below check
assert_block "mox_start floor $MOX_X,64,$MOX_Z" "$MOX_X" 64 "$MOX_Z" "dirt"

# ── 4. Chest + bedrock ──────────────────────────────────────────────
echo "── 4. Chest + bedrock cap ──"
assert_block "storage chest $CHEST_X,$CHEST_Y,$CHEST_Z" "$CHEST_X" "$CHEST_Y" "$CHEST_Z" "chest"
assert_block "bedrock NW $PAD_X1,$BEDROCK_Y,$PAD_Z1" "$PAD_X1" "$BEDROCK_Y" "$PAD_Z1" "bedrock"
assert_block "bedrock SE $PAD_X2,$BEDROCK_Y,$PAD_Z2" "$PAD_X2" "$BEDROCK_Y" "$PAD_Z2" "bedrock"

# ── 5. Mox position + inventory ─────────────────────────────────────
# Pipe JSON into python on stdin — embedding the raw body in `python -c`
# fails when the JSON has quotes/braces that confuse the shell's
# argument expansion.
echo "── 5. Mox bot ──"
pos_check=$(curl -sf "$MOX_URL/status" 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin).get('data', {}).get('position', {})
except Exception as e:
    print(f'parse-error|no'); sys.exit()
x, y, z = d.get('x'), d.get('y'), d.get('z')
if x is None or y is None or z is None:
    print('missing|no'); sys.exit()
in_x = $PAD_X1 <= x <= $PAD_X2
in_z = $PAD_Z1 <= z <= $PAD_Z2
on_pad = y >= $FLOOR_Y + 0.5
verdict = 'yes' if (in_x and in_z and on_pad) else 'no'
print(f'({x},{y},{z})|{verdict}')
" 2>/dev/null)
mpos="${pos_check%%|*}"
ok="${pos_check##*|}"
if [[ "$ok" == "yes" ]]; then
  printf '  %s  Mox at %s inside pad\n' "$OK" "$mpos"
else
  printf '  %s  Mox at %s NOT on pad (need x:%d..%d, z:%d..%d, y>=%d)\n' \
    "$NO" "$mpos" "$PAD_X1" "$PAD_X2" "$PAD_Z1" "$PAD_Z2" "$((FLOOR_Y + 1))" >&2
  fail=1
fi

inv_check=$(curl -sf "$MOX_URL/inventory" 2>/dev/null | python3 -c "
import json, sys
try:
    cats = json.load(sys.stdin).get('data', {}).get('categories', {})
except Exception:
    print('parse-error|no'); sys.exit()
items = {it['name']: it['count'] for cat in cats.values() for it in cat}
hoe = items.get('wooden_hoe', 0)
seeds = items.get('wheat_seeds', 0)
ok = (hoe == 1 and 60 <= seeds <= 64)
print(f'hoe={hoe} seeds={seeds}|{ \"yes\" if ok else \"no\" }')
" 2>/dev/null)
inv_text="${inv_check%%|*}"
inv_ok="${inv_check##*|}"
if [[ "$inv_ok" == "yes" ]]; then
  printf '  %s  Mox inventory: %s\n' "$OK" "$inv_text"
else
  printf '  %s  Mox inventory: %s (expected hoe=1, seeds 60-64)\n' "$NO" "$inv_text" >&2
  fail=1
fi

# ── 6. Marks on BOTH bots (Mox for nav, Tester for verify) ──────────
# Per-bot mark DBs: Mox uses his own for navigation; Tester uses his
# own for `mc verify`. Both must have all 3 marks at correct coords.
echo "── 6. Marks on Mox + Tester ──"
mox_marks=$(curl -sf "$MOX_URL/marks" 2>/dev/null)
tester_marks=$(curl -sf "$TESTER_URL/marks" 2>/dev/null)
check_mark_on() {
  local who="$1" body="$2" name="$3" ex_x="$4" ex_y="$5" ex_z="$6"
  local result
  result=$(echo "$body" | python3 -c "
import json, sys
name = '$name'
ex_x, ex_y, ex_z = $ex_x, $ex_y, $ex_z
try:
    marks = json.load(sys.stdin).get('data', {}).get('marks', [])
except Exception:
    print('parse-error'); sys.exit()
for m in marks:
    if m.get('name') == name:
        x, y, z = m.get('x'), m.get('y'), m.get('z')
        if x == ex_x and y == ex_y and z == ex_z:
            print('ok')
        else:
            print(f'wrong({x},{y},{z})')
        break
else:
    print('absent')
" 2>/dev/null)
  if [[ "$result" == "ok" ]]; then
    printf '  %s  %s mark %s at (%d, %d, %d)\n' "$OK" "$who" "$name" "$ex_x" "$ex_y" "$ex_z"
  else
    printf '  %s  %s mark %s: %s (expected %d, %d, %d)\n' "$NO" "$who" "$name" "$result" "$ex_x" "$ex_y" "$ex_z" >&2
    fail=1
  fi
}
for who_marks in "Mox:$mox_marks" "Tester:$tester_marks"; do
  who="${who_marks%%:*}"; body="${who_marks#*:}"
  check_mark_on "$who" "$body" wheat_plot  "$WATER_X" "$WATER_Y" "$WATER_Z"
  check_mark_on "$who" "$body" wheat_chest "$CHEST_X" "$CHEST_Y" "$CHEST_Z"
  check_mark_on "$who" "$body" wheat_start "$MOX_X"   "$MOX_Y"   "$MOX_Z"
done

# ── Verdict ─────────────────────────────────────────────────────────
echo
if [[ $fail -eq 0 ]]; then
  echo "validate-wheat-fixture: all bounds checks PASSED"
  exit 0
else
  echo "validate-wheat-fixture: bounds check FAILED — do NOT launch trial" >&2
  exit 1
fi
