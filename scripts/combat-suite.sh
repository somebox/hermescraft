#!/bin/bash
# Repeatable L3 combat suite.
#
# Repeatability invariants (enforced before every test):
#   - Tester is in dimension landfolk-test (mvtp), at safe-home (52, 65, 52).
#   - All effects cleared (no poison/weakness/regen carry-over).
#   - Inventory cleared. StuckArrowCount zeroed (no leftover arrows in body).
#   - All mobs/items/arrows in landfolk-test killed.
#   - HP topped up to 20 via instant_health.
#   - Saturation topped up so hunger ticks don't damage the bot.
#   - Gamerules clamped: doMobSpawning=false, doDaylightCycle=false, mobGriefing=false, keepInventory=true.
#   - Reactive in HOLD during reset+prep; flipped to NORMAL only at measurement start.
set -u
R=/tmp/rcon.sh
MAX_T="${MAX_T:-30}"
GAP="${GAP:-3}"
SKILL="${COMBAT_SKILL_DEFAULT:-0.5}"
PORT="${PORT:-3004}"

# Reactive-layer test fixtures only.
# Excluded (agent-driven, not reactive):
#   L3.63 attack_cow_food   — agent decides to hunt food
#   L3.65 flee_to_mark      — agent picks the destination mark
#   L3.68 shoot_bow         — agent fires bow, reactive can't drive it
FIXTURES=(
  "L3.60_fight_zombie.yaml"
  "L3.61_fight_skeleton.yaml"
  "L3.62_flee_creeper.yaml"
  "L3.64_fight_retreat_low_hp.yaml"
  "L3.66_dodge_skeleton.yaml"
  "L3.67_fight_two_zombies_obstacles.yaml"
  # L3.69 (3 zombies) dropped — redundant with L3.70 (4 zombies) and L3.71.
  "L3.70_multi_zombie_stress.yaml"
  "L3.71_multi_zombie_four.yaml"
  "L3.72_mixed_skeletons_zombie.yaml"
)

# Hard reset run BEFORE each test's own prep. Uses /kill + auto-respawn
# because Paper blocks `data merge entity` on players and won't let us
# zero StuckArrowCount or active_effects directly. /kill clears every
# attached effect, every arrow stuck in the body, and resets HP to 20.
# Mineflayer auto-respawns the bot in ~1s.
hard_reset() {
  curl -s -X POST "http://localhost:$PORT/action/mode" -H 'Content-Type: application/json' -d '{"name":"hold"}' >/dev/null
  # 1. Clamp gamerules + spawn point so the auto-respawn lands at safe-home.
  $R 'execute in landfolk-test run gamerule doMobSpawning false' >/dev/null
  $R 'execute in landfolk-test run gamerule doDaylightCycle false' >/dev/null
  $R 'execute in landfolk-test run gamerule mobGriefing false' >/dev/null
  $R 'execute in landfolk-test run gamerule keepInventory true' >/dev/null
  $R 'execute in landfolk-test run spawnpoint Tester 52 65 52' >/dev/null
  # 2. Force respawn — only clean way to zero StuckArrowCount / hit cooldowns
  #    / particle effects / damage tilt animation on a Paper player.
  $R 'kill Tester' >/dev/null
  # 3. Wait for mineflayer to reconnect the player session.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    local hp
    hp=$(curl -s "http://localhost:$PORT/observe" 2>/dev/null | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("state",{}).get("health","?"))
except: print("?")')
    [ "$hp" = "20" ] && break
  done
  # 4. World scrub: remove any leftover mobs / arrows / item drops.
  $R 'mvtp Tester landfolk-test' >/dev/null 2>&1 || true
  $R 'execute in landfolk-test run tp Tester 52 65 52' >/dev/null
  $R 'execute in landfolk-test run kill @e[type=!player]' >/dev/null
  $R 'execute in landfolk-test run kill @e[type=arrow]' >/dev/null
  $R 'execute in landfolk-test run kill @e[type=item]' >/dev/null
  $R 'execute in landfolk-test run kill @e[type=experience_orb]' >/dev/null
  # 5. Top up saturation so hunger ticks don't damage during long fights.
  $R 'effect give Tester minecraft:saturation 5 5 true' >/dev/null
  $R 'clear Tester' >/dev/null
  sleep 0.5
}

# Flip reactive on AFTER fixture prep so bot doesn't engage half-built arenas.
arm_bot() {
  curl -s -X POST "http://localhost:$PORT/action/combat_skill" -H 'Content-Type: application/json' -d "{\"value\":$SKILL}" >/dev/null
  curl -s -X POST "http://localhost:$PORT/action/mode" -H 'Content-Type: application/json' -d '{"name":"normal"}' >/dev/null
}

count_targets() {
  local tag="x_$RANDOM"
  $R "execute in landfolk-test run execute as @e[type=!player,tag=target] run tag @s add $tag" 2>&1 | grep -oE 'Added tag' | wc -l | tr -d ' '
}
get_hp() {
  curl -s "http://localhost:$PORT/observe" 2>/dev/null \
    | python3 -c 'import sys,json
try: d=json.load(sys.stdin); print(d.get("state",{}).get("health","?"))
except: print("?")'
}
get_pos() {
  curl -s "http://localhost:$PORT/observe" 2>/dev/null \
    | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); p=d.get("state",{}).get("position",{})
    print(f"({p.get(chr(120),0):.1f},{p.get(chr(121),0):.0f},{p.get(chr(122),0):.1f})")
except: print("?")'
}
get_effects() {
  $R 'data get entity Tester active_effects' 2>&1 | grep -oE 'minecraft:[a-z_]+' | tr '\n' ',' | sed 's/,$//'
}

PASS=()
FAIL=()
DETAILS=()

for FIX in "${FIXTURES[@]}"; do
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo " $FIX  (skill=$SKILL, max=${MAX_T}s)"
  echo "════════════════════════════════════════════════════════════════"

  echo "  [reset]"
  hard_reset
  EFF=$(get_effects)
  RESET_HP=$(get_hp)
  RESET_POS=$(get_pos)
  echo "  reset state: hp=$RESET_HP pos=$RESET_POS effects=[$EFF]"

  echo "  [prep]"
  bash /Users/foz/hermescraft/scripts/run-fixture.sh prep \
    "/Users/foz/hermescraft/data/test-fixtures/L3/$FIX" 2>&1 | tail -2
  $R 'execute in landfolk-test run gamerule doMobSpawning false' >/dev/null
  arm_bot

  T0_HP=$(get_hp)
  T0_TARGETS=$(count_targets)
  echo "  T= 0  hp=$T0_HP  targets=$T0_TARGETS  pos=$(get_pos)"

  RESULT="timeout"
  for i in $(seq 1 "$MAX_T"); do
    sleep 1
    HP=$(get_hp)
    N=$(count_targets)
    POS=$(get_pos)
    printf "  T=%2ds hp=%5s targets=%s pos=%s\n" "$i" "$HP" "$N" "$POS"
    # L3.62 creeper-flee: target dying means the creeper DETONATED — that's
    # a failure (the bot didn't keep distance). For everything else, target
    # count = 0 is the win condition.
    if [ "$N" = "0" ] && [ "$T0_TARGETS" != "0" ]; then
      case "$FIX" in
        L3.62_*) RESULT="creeper_detonated at ${i}s, hp=$HP" ;;
        *)       RESULT="cleared at ${i}s, hp=$HP" ;;
      esac
      break
    fi
    case "$FIX" in
      L3.62_*)
        # Pass after 12s of survival with HP > 15. Fixed threshold (not
        # MAX_T-5) — the avoidance algorithm settles into a perimeter
        # circle within 5s, so 12s of clean distance-keeping is enough
        # signal that escape is working.
        if [ "$i" -ge 12 ] && [ "$HP" != "?" ] && [ "${HP%.*}" -gt 15 ] 2>/dev/null; then
          RESULT="survived ${i}s, hp=$HP"
          break
        fi
        ;;
      L3.65_*|L3.66_*)
        if [ "$i" = "$((MAX_T - 5))" ] && [ "$HP" != "?" ] && [ "${HP%.*}" -gt 0 ] 2>/dev/null; then
          RESULT="survived ${i}s, hp=$HP"
          break
        fi
        ;;
    esac
  done

  case "$RESULT" in
    cleared*|survived*) PASS+=("$FIX") ;;
    *) FAIL+=("$FIX") ;;
  esac
  DETAILS+=("$FIX → $RESULT")

  bash /Users/foz/hermescraft/scripts/run-fixture.sh cleanup \
    "/Users/foz/hermescraft/data/test-fixtures/L3/$FIX" >/dev/null 2>&1

  echo "  ✓ $FIX → $RESULT"
  if [ "$GAP" -gt 0 ]; then sleep "$GAP"; fi
done

echo ""
echo "════════════════════════════════════════════════════════════════"
echo " SUMMARY  (skill=$SKILL)"
echo "════════════════════════════════════════════════════════════════"
echo "  PASS: ${#PASS[@]} / ${#FIXTURES[@]}"
echo "  FAIL: ${#FAIL[@]}"
echo ""
for d in "${DETAILS[@]}"; do echo "    $d"; done
if [ "${#FAIL[@]}" -gt 0 ]; then
  echo ""
  echo "  Failed fixtures:"
  for f in "${FAIL[@]}"; do echo "    - $f"; done
fi
