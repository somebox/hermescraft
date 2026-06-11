#!/usr/bin/env bash
# Proc-nav road trial preflight — relaunch readiness checklist.
#
# Runs ALL the steps needed between the end of one road trial and the start
# of another. Designed to be idempotent and parameterized so it can be reused
# for variant runs (different bots, different tool kits, different boards).
#
# Steps (in order):
#   1. Verify each bot in $BOTS is alive AND running the current build (has
#      the new mc verbs: clear_strip, deck, fell_tree, level_ground)
#   2. Re-install skills on role profiles (calls setup-proc-nav-dual-bot.sh
#      + setup-planner-w2.sh). Idempotent.
#   3. Verify the doctrine landed in the installed skill files (target_y
#      from terrain_top, mc deck mention, etc.)
#   4. Reset the $BOARD kanban (archives all cards, kills the dispatcher)
#   5. Zero the per-role MEMORY.md so agents don't carry stale target_y=67
#      mental models from the prior failed run
#   6. Kit each bot via RCON `give` (iron tools + shears). No reliance on
#      supply-chest withdrawal, which the previous trial showed was flaky.
#   7. Print a green/red readiness checklist + the launch command to copy/paste
#
# Parameters (env vars, all optional — sensible defaults):
#   BOARD              kanban board (default proc-nav-lab)
#   BOTS               comma list of bot stems (default mox,pip)
#   TOOL_KIT           comma list of items to give each bot
#                      (default iron_shovel,iron_axe,iron_pickaxe,iron_sword,shears)
#   SUPPLY_KIT         comma list of "item:count" stacks to give (optional)
#                      e.g. "cobblestone:128,dirt:128,oak_planks:32,cooked_beef:16"
#   CLEAR_INVENTORY    true (default) → /clear before /give so the kit lands
#                      cleanly. Previous trial proved partial inventories
#                      cause /give items to drop on the ground silently.
#   WORLD              MC world (default from server.local.yaml world.name)
#   ROLE_PROFILES      comma list to zero memories of
#                      (default planner,navigator,navigator-pip,builder,builder-mox)
#   DRY_RUN            true → print commands without running
#   SKIP_BOT_VERIFY    true → don't check bot/help endpoint
#   SKIP_SKILL_INSTALL true → don't re-run setup-*.sh
#   SKIP_DOCTRINE_CHECK true → don't grep skill files
#   SKIP_BOARD_RESET   true → leave board state alone
#   SKIP_MEMORY_RESET  true → leave MEMORY.md files alone
#   SKIP_INVENTORY     true → don't give bots tools
#   SKIP_WORLD_FRESHNESS true → don't check for accumulated trial artifacts
#   MATERIALIZE        true → when world is stale, actually reset proc-nav
#                      via reset-proc-lab.py (evac → mv delete OTP → mv
#                      create); default is warn-only with the command echoed
#   STRICT             true → fail-fast on any RED check (default: collect all, exit non-zero)
#   RESTART_STALE_BOTS true → kill + restart any stale bot (skips the manual restart instruction)
#   MC_HOST            override Minecraft server host (default from running bot or 192.168.1.202)
#   MC_PORT            (default 25565)
#
# Exit codes:
#   0 — all checks green, ready to launch
#   1 — one or more checks failed (operator must inspect)
#   2 — unrecoverable error (config missing, etc)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

# ── Parameter resolution ─────────────────────────────────────────────────
BOARD="${BOARD:-proc-nav-lab}"
BOTS="${BOTS:-mox,pip}"
TOOL_KIT="${TOOL_KIT:-iron_shovel,iron_axe,iron_pickaxe,iron_sword,shears}"
ROLE_PROFILES="${ROLE_PROFILES:-planner,navigator,navigator-pip,builder,builder-mox}"
DRY_RUN="${DRY_RUN:-false}"
SKIP_BOT_VERIFY="${SKIP_BOT_VERIFY:-false}"
SKIP_SKILL_INSTALL="${SKIP_SKILL_INSTALL:-false}"
SKIP_DOCTRINE_CHECK="${SKIP_DOCTRINE_CHECK:-false}"
SKIP_BOARD_RESET="${SKIP_BOARD_RESET:-false}"
SKIP_MEMORY_RESET="${SKIP_MEMORY_RESET:-false}"
SKIP_INVENTORY="${SKIP_INVENTORY:-false}"
SKIP_WORLD_FRESHNESS="${SKIP_WORLD_FRESHNESS:-false}"
SKIP_ROADPLAN_TOOLCHAIN="${SKIP_ROADPLAN_TOOLCHAIN:-false}"
STRICT="${STRICT:-false}"
RESTART_STALE_BOTS="${RESTART_STALE_BOTS:-false}"
MC_HOST_DEFAULT="${MC_HOST:-192.168.1.202}"
MC_PORT_DEFAULT="${MC_PORT:-25565}"
SUPPLY_KIT="${SUPPLY_KIT:-cobblestone:128,dirt:128,oak_planks:32,torch:32,cooked_beef:16}"
CLEAR_INVENTORY="${CLEAR_INVENTORY:-true}"

WORLD="${WORLD:-$(awk '/^  name:/ {print $2; exit}' server.local.yaml 2>/dev/null || echo proc-nav)}"

# ── Banner ────────────────────────────────────────────────────────────────
say() { printf '\033[36m[preflight]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m  ✓\033[0m %s\n' "$*"; OK_COUNT=$((OK_COUNT+1)); }
warn(){ printf '\033[33m  ⚠\033[0m %s\n' "$*"; WARN_COUNT=$((WARN_COUNT+1)); }
fail(){ printf '\033[31m  ✗\033[0m %s\n' "$*"; FAIL_COUNT=$((FAIL_COUNT+1)); [[ "$STRICT" == "true" ]] && exit 1; }
header(){ printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

OK_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

cat <<EOF
\033[1mProc-nav road trial preflight\033[0m
  board   = $BOARD
  bots    = $BOTS
  world   = $WORLD
  kit     = $TOOL_KIT
  roles   = $ROLE_PROFILES
  dry_run = $DRY_RUN
EOF
[[ "$DRY_RUN" == "true" ]] && say "DRY_RUN — actions will be logged but not executed"

# ── Helper: read api_port from data/bots/<stem>.yaml ──────────────────────
bot_port() { awk '/^api_port:/ {print $2}' "data/bots/${1}.yaml"; }
bot_user() { awk '/^username:/ {print $2}' "data/bots/${1}.yaml"; }

# ── Helper: run() — gated by DRY_RUN ──────────────────────────────────────
run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '\033[2m  [dry] %s\033[0m\n' "$*"
  else
    eval "$@"
  fi
}

# ── Helper: rcon command ──────────────────────────────────────────────────
RCON_PY=$(cat <<'PYEOF'
import json, sys
from pathlib import Path
sys.path.insert(0, '/Users/foz/hermescraft')
from mapcatalog.rcon_client import make_rcon
from mapcatalog.server_config import load_server_config
cfg = load_server_config(Path('/Users/foz/hermescraft/server.local.yaml'))
client = make_rcon(cfg)
for cmd in sys.argv[1:]:
    out = client.run(cmd)
    print(out or '<no output>')
PYEOF
)
rcon() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '\033[2m  [dry-rcon] %s\033[0m\n' "$*"
  else
    python3 -c "$RCON_PY" "$@"
  fi
}

# =========================================================================
# Step 0 — World freshness check
# =========================================================================
# Proc-nav-1781079999 postmortem: relaunch-preflight resets the board, kit,
# and memories but does NOT reset the Minecraft world. Dug holes, placed
# dirt caps, and marker blocks from prior trials accumulate inside the
# corridor, biasing any trial-to-trial comparison.
#
# This step warns when there's evidence of accumulated artifacts (any
# postmortem scorecard newer than the materialized map file). The actual
# reset is operator-driven for now — auto-reset has bot-lifecycle ordering
# subtleties (mvtp to hub → mv delete with OTP → mv create → mvtp back)
# that need separate work. Once the auto-reset path lands, this step can
# trigger it via MATERIALIZE=true.
if [[ "$SKIP_WORLD_FRESHNESS" != "true" ]]; then
  header "0. World freshness — accumulated trial artifacts"
  map_json="$REPO_ROOT/data/runtime/last-scenario-map.json"
  if [[ -f "$map_json" ]]; then
    # audit.probed_at is the genuine probe timestamp; the file's mtime gets
    # touched by every prep-board / mvtp run so it's not a reliable signal.
    probed_at=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('audit',{}).get('probed_at') or '')" "$map_json" 2>/dev/null || echo "")
    seed=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('seed','?'))" "$map_json" 2>/dev/null || echo "?")
    if [[ -d "$REPO_ROOT/data/postmortems/proc-nav-lab" && -n "$probed_at" ]]; then
      # Count postmortem scorecards with run_id (unix seconds) newer than probed_at.
      newer_postmortems=$(python3 - "$REPO_ROOT/data/postmortems/proc-nav-lab" "$probed_at" <<'PY'
import sys, os, re
from datetime import datetime, timezone
root, probed_at = sys.argv[1], sys.argv[2]
try:
    probed_ts = int(datetime.fromisoformat(probed_at.replace("Z", "+00:00")).timestamp())
except Exception:
    probed_ts = 0
count = 0
for name in os.listdir(root):
    m = re.match(r"proc-nav-(\d+)$", name)
    if m and int(m.group(1)) > probed_ts:
        sc = os.path.join(root, name, "scorecard.json")
        if os.path.exists(sc):
            count += 1
print(count)
PY
)
    else
      newer_postmortems=0
    fi
    if [[ "$newer_postmortems" -eq 0 ]]; then
      ok "world fresh — no postmortems since last map probe (${probed_at:-unknown})"
    elif [[ "${MATERIALIZE:-}" == "true" ]]; then
      # Auto-reset path. reset-proc-lab.py is world-agnostic (--world,
      # --hub, --bots) — wrapping it here keeps the relaunch flow honest
      # for proc-nav. The script handles evac → mv delete (OTP) → mv create.
      # After reset, the bots end up in the hub world; prep-board's
      # proc-nav-mvtp-bots.py mvtp's them back into proc-nav.
      warn "world stale — $newer_postmortems trial postmortem(s) since last map probe; MATERIALIZE=true → resetting proc-nav (seed=$seed)"
      if [[ "$DRY_RUN" == "true" ]]; then
        printf '\033[2m  [dry-mat] python3 scripts/reset-proc-lab.py --world proc-nav --seed %s --bots Mox,Pip\033[0m\n' "$seed"
      else
        if python3 scripts/reset-proc-lab.py \
             --world proc-nav --seed "$seed" --bots Mox,Pip \
             --no-verify >/tmp/preflight-materialize.log 2>&1; then
          ok "proc-nav world reset (log: /tmp/preflight-materialize.log)"
        else
          fail "world reset failed — see /tmp/preflight-materialize.log"
        fi
      fi
    else
      warn "world stale — $newer_postmortems trial postmortem(s) since last map probe (${probed_at:-unknown}); corridor artifacts likely"
      printf '\033[2m    map seed:      %s\033[0m\n' "$seed"
      printf '\033[2m    To reset (operator-driven):\n      python3 scripts/reset-proc-lab.py --world proc-nav --seed %s --bots Mox,Pip\033[0m\n' "$seed"
      printf '\033[2m    Or re-run with MATERIALIZE=true to reset inline.\033[0m\n'
      printf '\033[2m    Suppress this check entirely with SKIP_WORLD_FRESHNESS=true.\033[0m\n'
    fi
  else
    warn "no last-scenario-map.json — materialize first (scripts/proc-nav-trial.sh prep-map)"
  fi
else
  say "skipping world freshness check"
fi

# =========================================================================
# Step 1 — Bot freshness check
# =========================================================================
# Helper: probe whether a bot port is responding AND has the new road verbs
# loaded AND is running the slow movement profile. Returns 0 (alive + new),
# 1 (DOWN), or 2 (STALE — alive but missing one or more of clear_strip /
# deck / fell_tree, or /health doesn't report movement_profile=slow).
_bot_status() {
  local port="$1"
  local resp
  resp=$(curl -s --max-time 3 "http://127.0.0.1:${port}/" 2>&1 || true)
  if [[ -z "$resp" ]] || ! echo "$resp" | grep -q '"connected":true'; then
    return 1  # DOWN
  fi
  for verb in clear_strip deck fell_tree; do
    local probe
    probe=$(curl -s --max-time 3 -X POST -H "content-type: application/json" -d '{}' "http://127.0.0.1:${port}/action/${verb}" 2>&1 || true)
    if echo "$probe" | grep -qE "Not found|Unknown action"; then
      return 2  # STALE
    fi
  done
  # Movement-profile assertion: an old build doesn't expose movement_profile
  # at all; a new build launched without BOT_MOVEMENT_PROFILE=slow exposes
  # "default". Either way the bot sprints (0.28m/tick > the F58 ±0.25m
  # waypoint tolerance) and wedges on block seams — proc-nav-1781014144's
  # core regression. A verb probe alone CANNOT catch this: the 2026-06-10
  # rerun reported "alive, new verbs" for a 9h-old sprinting process.
  local health
  health=$(curl -s --max-time 3 "http://127.0.0.1:${port}/health" 2>&1 || true)
  if ! echo "$health" | grep -q '"movement_profile":"slow"'; then
    return 2  # STALE — wrong/missing movement profile
  fi
  # Build drift: the bot stamps BUILD_COMMIT at spawn (now exported by
  # _start_bot below); /health compares it to disk HEAD. drift:true means
  # the source moved since this process started. NOTE: dirty-at-spawn →
  # still-dirty-at-same-commit does NOT register as drift (uncommitted
  # edits after spawn are invisible) — during active development, restart
  # explicitly after editing bot code.
  if echo "$health" | grep -q '"drift":true'; then
    return 2  # STALE — running code predates current disk HEAD
  fi
  return 0  # OK
}

# Helper: kill any existing bot process for this user/port pair (best-effort
# match), then spawn a fresh `node bot/server.js` with the right env. Waits
# up to 30s for the bot to connect and report new verbs. Returns 0 on
# success, 1 on timeout.
_start_bot() {
  local bot="$1" port="$2" user="$3"
  local viewer_port=$((4000 + (port % 1000)))
  local log_path="/tmp/preflight-bot-${bot}.log"
  # Kill any existing process bound to this user+port (covers both stale-
  # build and zombie restarts). Match on env vars in argv.
  local existing_pid
  existing_pid=$(ps -E -axo pid,command 2>/dev/null | awk -v u="MC_USERNAME=$user" -v p="API_PORT=$port" '$0 ~ /node.*server\.js/ && index($0, u) && index($0, p) {print $1; exit}')
  if [[ -z "$existing_pid" ]]; then
    existing_pid=$(ps -E -axo pid,command 2>/dev/null | awk -v u="MC_USERNAME=$user" '$0 ~ /node.*server\.js/ && index($0, u) {print $1; exit}')
  fi
  if [[ -n "$existing_pid" ]]; then
    run "kill -TERM $existing_pid"
    sleep 3
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '\033[2m  [dry] spawn %s on :%s (viewer :%s)\033[0m\n' "$user" "$port" "$viewer_port"
    return 0
  fi
  # Spawn-time build stamp — without BUILD_COMMIT the bot's /health reports
  # spawn:null and its drift detector can never fire (the 2026-06-10 rerun
  # kept a 9h-old process alive because drift was silently disabled).
  # Mirrors the capture in landfolk-control.sh:565.
  local build_commit build_branch build_dirty
  build_commit=$(git rev-parse HEAD 2>/dev/null || echo '')
  build_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')
  if [[ -n "$build_commit" && -n "$(git status --porcelain -uno 2>/dev/null)" ]]; then
    build_dirty=1
  else
    build_dirty=0
  fi
  # nohup + (cmd &) double-bg so the bot survives the script returning.
  # BOT_MOVEMENT_PROFILE=slow is REQUIRED for kanban trial bots: it disables
  # sprinting (0.28m/tick > the F58 ±0.25m waypoint tolerance — sprinting
  # bots overrun waypoints and stall riding block edges), forbids parkour,
  # and triples jumpCost. proc-nav-1781014144 ran with the default profile
  # because this launcher didn't set it — see that postmortem's movement
  # deep-dive. scripts/landfolk:101 has always defaulted to slow.
  (env MC_USERNAME="$user" API_PORT="$port" VIEWER_PORT="$viewer_port" \
       BOT_MOVEMENT_PROFILE="${BOT_MOVEMENT_PROFILE:-slow}" \
       BUILD_COMMIT="$build_commit" BUILD_BRANCH="$build_branch" \
       BUILD_DIRTY="$build_dirty" BUILD_CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       PAPERMCP_HOST="$MC_HOST_DEFAULT" MC_HOST="$MC_HOST_DEFAULT" MC_PORT="$MC_PORT_DEFAULT" \
       nohup node bot/server.js >"$log_path" 2>&1 &) >/dev/null 2>&1
  # Poll for up to 30s (slower hosts need more than 10 for the MC handshake).
  local i
  for i in 1 2 3 4 5 6; do
    sleep 5
    if _bot_status "$port" && [[ $? -eq 0 ]]; then
      return 0
    fi
  done
  return 1
}

if [[ "$SKIP_BOT_VERIFY" != "true" ]]; then
  header "1. Bot servers alive + running current build"
  for bot in ${BOTS//,/ }; do
    port=$(bot_port "$bot")
    user=$(bot_user "$bot")
    if [[ -z "$port" ]]; then
      fail "$bot: no api_port in data/bots/${bot}.yaml — skipping"
      continue
    fi
    _bot_status "$port"
    case $? in
      0)
        ok "$bot (:$port) alive, new verbs present (clear_strip, deck, fell_tree), movement_profile=slow"
        ;;
      1)
        # DOWN — no response at all.
        if [[ "$RESTART_STALE_BOTS" == "true" ]]; then
          if _start_bot "$bot" "$port" "$user"; then
            ok "$bot (:$port) started from down (log: /tmp/preflight-bot-${bot}.log)"
          else
            fail "$bot (:$port) — start attempted but bot didn't come up within 30s (log: /tmp/preflight-bot-${bot}.log)"
          fi
        else
          fail "$bot ($user, :$port) — bot server DOWN. Re-run with RESTART_STALE_BOTS=true to auto-start, or start manually: env MC_USERNAME=$user API_PORT=$port VIEWER_PORT=$((4000 + (port % 1000))) BOT_MOVEMENT_PROFILE=slow PAPERMCP_HOST=$MC_HOST_DEFAULT MC_HOST=$MC_HOST_DEFAULT MC_PORT=$MC_PORT_DEFAULT nohup node bot/server.js &"
        fi
        ;;
      2)
        # STALE — alive but old code.
        if [[ "$RESTART_STALE_BOTS" == "true" ]]; then
          if _start_bot "$bot" "$port" "$user"; then
            ok "$bot (:$port) restarted with new build (log: /tmp/preflight-bot-${bot}.log)"
          else
            fail "$bot (:$port) — restart attempted but bot didn't come up within 30s (log: /tmp/preflight-bot-${bot}.log)"
          fi
        else
          fail "$bot (:$port) — running STALE build (missing clear_strip/deck/fell_tree, or movement_profile != slow in /health). Re-run with RESTART_STALE_BOTS=true, or restart manually."
        fi
        ;;
    esac
  done
else
  say "skipping bot verify"
fi

# =========================================================================
# Step 2 — Skill installs
# =========================================================================
if [[ "$SKIP_SKILL_INSTALL" != "true" ]]; then
  header "2. Re-install skills on role profiles"
  if [[ -x prototypes/agent-arch/setup-planner-w2.sh ]]; then
    run "KANBAN_BOARD=$BOARD prototypes/agent-arch/setup-planner-w2.sh >/tmp/preflight-planner.log 2>&1" \
      && ok "planner skills installed (log: /tmp/preflight-planner.log)" \
      || fail "planner skill install failed — see /tmp/preflight-planner.log"
  else
    fail "prototypes/agent-arch/setup-planner-w2.sh missing or not executable"
  fi
  if [[ -x prototypes/agent-arch/setup-proc-nav-dual-bot.sh ]]; then
    run "KANBAN_BOARD=$BOARD prototypes/agent-arch/setup-proc-nav-dual-bot.sh >/tmp/preflight-dual-bot.log 2>&1" \
      && ok "dual-bot (navigator + builder) skills installed (log: /tmp/preflight-dual-bot.log)" \
      || fail "dual-bot skill install failed — see /tmp/preflight-dual-bot.log"
  else
    fail "prototypes/agent-arch/setup-proc-nav-dual-bot.sh missing"
  fi
else
  say "skipping skill install"
fi

# =========================================================================
# Step 3 — Doctrine sanity grep
# =========================================================================
if [[ "$SKIP_DOCTRINE_CHECK" != "true" ]]; then
  header "3. Doctrine landed in installed skill files"
  for role in navigator navigator-pip builder builder-mox; do
    skill_path="$HERMES_HOME/profiles/$role/skills/gaming/minecraft-roadbuilding/SKILL.md"
    if [[ ! -f "$skill_path" ]]; then
      warn "$role: no minecraft-roadbuilding skill installed (skipping)"
      continue
    fi
    # Two distinctive markers from the post-1780970837 doctrine rewrite:
    #   - "data.dispositions" — the new level_ground survey output that
    #     planners are supposed to read before issuing execute
    #   - "Adapt the plan if dispositions say so" — the explicit step in
    #     the per-segment workflow that didn't exist in the pre-rewrite
    #     version (which jumped straight from survey to shape).
    if grep -q "data\\.dispositions" "$skill_path" && grep -q "Adapt the plan if dispositions" "$skill_path"; then
      ok "$role: roadbuilding skill has new doctrine (dispositions + adapt-step)"
    else
      fail "$role: roadbuilding skill at $skill_path missing new doctrine — re-run skill install"
    fi
  done
  # Also check the planner's minecraft-planning surface
  plan_path="$HERMES_HOME/profiles/planner/skills/gaming/minecraft-planning/SKILL.md"
  if [[ -f "$plan_path" ]] && grep -q "Surveys drive plan adaptation" "$plan_path"; then
    ok "planner: minecraft-planning skill has survey-drives-adaptation rule"
  elif [[ -f "$plan_path" ]]; then
    fail "planner: minecraft-planning at $plan_path missing 'Surveys drive plan adaptation' — re-run skill install"
  fi
else
  say "skipping doctrine check"
fi

# =========================================================================
# Step 4 — Board reset
# =========================================================================
if [[ "$SKIP_BOARD_RESET" != "true" ]]; then
  header "4. Reset board $BOARD (archives existing cards, kills dispatcher)"
  if [[ -x scripts/reset-proc-nav-lab.sh ]]; then
    run "BOARD=$BOARD scripts/reset-proc-nav-lab.sh >/tmp/preflight-board-reset.log 2>&1" \
      && ok "board $BOARD reset" \
      || fail "board reset failed — see /tmp/preflight-board-reset.log"
  else
    fail "scripts/reset-proc-nav-lab.sh missing"
  fi
else
  say "skipping board reset"
fi

# =========================================================================
# Step 5 — Memory reset for role profiles
# =========================================================================
if [[ "$SKIP_MEMORY_RESET" != "true" ]]; then
  header "5. Zero MEMORY.md for road-trial role profiles"
  for role in ${ROLE_PROFILES//,/ }; do
    mem="$HERMES_HOME/profiles/$role/memories/MEMORY.md"
    if [[ ! -f "$mem" ]]; then
      warn "$role: no MEMORY.md at $mem (profile may not exist yet)"
      continue
    fi
    if [[ "$DRY_RUN" == "true" ]]; then
      printf '\033[2m  [dry] : >"%s"\033[0m\n' "$mem"
      ok "$role MEMORY.md (dry-run)"
    else
      : >"$mem" && ok "$role MEMORY.md zeroed" || fail "$role MEMORY.md zero failed"
    fi
  done
else
  say "skipping memory reset"
fi

# =========================================================================
# Step 6 — Tool kit via RCON
# =========================================================================
if [[ "$SKIP_INVENTORY" != "true" ]]; then
  header "6. Kit each bot with $TOOL_KIT (+ supplies)"
  rcon_cmds=()
  for bot in ${BOTS//,/ }; do
    user=$(bot_user "$bot")
    if [[ -z "$user" ]]; then
      fail "$bot: no username — skipping kit"
      continue
    fi
    # Step 6a: clear inventory so /give isn't dropped on a full inventory.
    # The previous trial showed /give silently dropping items to the
    # ground when the bot's hotbar + main inventory were full of
    # snowballs/dirt from prior runs.
    if [[ "$CLEAR_INVENTORY" == "true" ]]; then
      rcon_cmds+=("execute in $WORLD run clear $user")
    fi
    # Step 6b: tools.
    for item in ${TOOL_KIT//,/ }; do
      rcon_cmds+=("execute in $WORLD run give $user minecraft:$item")
    done
    # Step 6c: supplies. Each entry is "name:count" — split with awk so we
    # don't have to depend on bash <4 associative arrays.
    if [[ -n "$SUPPLY_KIT" ]]; then
      for kv in ${SUPPLY_KIT//,/ }; do
        item="${kv%%:*}"
        count="${kv##*:}"
        # /give caps at 64 for stackable items in vanilla; pass as-is and
        # let the server cap.
        rcon_cmds+=("execute in $WORLD run give $user minecraft:$item $count")
      done
    fi
  done
  if [[ ${#rcon_cmds[@]} -gt 0 ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      for c in "${rcon_cmds[@]}"; do printf '\033[2m  [dry-rcon] %s\033[0m\n' "$c"; done
      ok "${#rcon_cmds[@]} RCON commands (dry-run)"
    else
      python3 -c "$RCON_PY" "${rcon_cmds[@]}" >/tmp/preflight-kit.log 2>&1 \
        && ok "${#rcon_cmds[@]} RCON commands sent (clear + tools + supplies; log: /tmp/preflight-kit.log)" \
        || fail "RCON kit dispatch failed — see /tmp/preflight-kit.log"
    fi
  fi
  # Step 6d: verify each tool actually landed in inventory. /clear empties,
  # then /give MUST succeed. If a tool isn't in inventory after this step,
  # something's wrong upstream (item name typo, server rejection).
  if [[ "$DRY_RUN" != "true" && "$SKIP_BOT_VERIFY" != "true" ]]; then
    sleep 2  # let mineflayer process window updates
    for bot in ${BOTS//,/ }; do
      port=$(bot_port "$bot")
      user=$(bot_user "$bot")
      [[ -z "$port" || -z "$user" ]] && continue
      MC_API_URL="http://127.0.0.1:${port}" MC_USERNAME="$user" \
        inv_out=$(MC_API_URL="http://127.0.0.1:${port}" MC_USERNAME="$user" mc inventory 2>&1)
      missing_tools=()
      for item in ${TOOL_KIT//,/ }; do
        if ! echo "$inv_out" | grep -q "\\b$item\\b"; then
          missing_tools+=("$item")
        fi
      done
      if [[ ${#missing_tools[@]} -gt 0 ]]; then
        fail "$bot inventory verification: missing ${missing_tools[*]} after kit. (likely cause: server rejected give OR bot inventory cache stale)"
      else
        ok "$bot inventory has all tools: $TOOL_KIT"
      fi
    done
  fi
else
  say "skipping inventory kit"
fi

# =========================================================================
# Step 7 — roadplan toolchain (S4 / adaptive road planning §8.0.3)
# =========================================================================
# The trial's planner pipes `mc … --json | roadplan ingest` and runs
# `roadplan solve / render`. Catch the bin wrapper / venv / spec file
# problems here, before bots have generated any samples to feed it.
# Worker-shell env vars are reported as a *warn* only — this step runs
# in the planner's shell; the W1 env_passthrough lesson is that the
# launcher must also verify inside the worker's spawned shell.
if [[ "$SKIP_ROADPLAN_TOOLCHAIN" != "true" ]]; then
  header "7. roadplan toolchain"
  if [[ ! -x "$REPO_ROOT/bin/roadplan" ]]; then
    fail "bin/roadplan missing or not executable"
  else
    if [[ "$DRY_RUN" == "true" ]]; then
      printf '\033[2m  [dry] %s preflight\033[0m\n' "$REPO_ROOT/bin/roadplan"
      ok "roadplan preflight (dry-run)"
    else
      _tc_log=/tmp/preflight-roadplan-toolchain.log
      if "$REPO_ROOT/bin/roadplan" preflight >"$_tc_log" 2>&1; then
        while IFS= read -r ln; do
          case "$ln" in
            "✓ "*) ok "${ln#✓ }" ;;
            "⚠ "*) warn "${ln#⚠ }" ;;
            "✗ "*) fail "${ln#✗ }" ;;
            *)     printf '\033[2m    %s\033[0m\n' "$ln" ;;
          esac
        done <"$_tc_log"
      else
        fail "roadplan preflight reported failures — see $_tc_log"
      fi
    fi
  fi
else
  say "skipping roadplan toolchain check"
fi

# =========================================================================
# Final readiness checklist
# =========================================================================
echo
header "Readiness summary"
say "✓ $OK_COUNT  ⚠ $WARN_COUNT  ✗ $FAIL_COUNT"
echo
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  cat <<EOF
\033[1;32mREADY TO LAUNCH\033[0m

Next steps:
  # Set up two-bot map + dispatch
  BOARD=$BOARD scripts/proc-nav-trial.sh prep-board
  PROC_NAV_GRAPH=proc-scout-road BOARD=$BOARD scripts/proc-nav-trial.sh run-road

  # Tail logs in one terminal
  scripts/proc-nav-tail.sh --reasoning

EOF
  exit 0
else
  cat <<EOF
\033[1;31mNOT READY — $FAIL_COUNT check(s) failed\033[0m

Address the red lines above, then re-run:
  scripts/proc-nav-relaunch-preflight.sh

To bypass specific phases (after manually addressing):
  SKIP_BOT_VERIFY=true SKIP_SKILL_INSTALL=true scripts/proc-nav-relaunch-preflight.sh
EOF
  exit 1
fi
