#!/usr/bin/env bash
# genesis-v2.sh — colony integration test on the procworld stack.
#
# Boots a from-scratch colony of narrow specialists on a fresh plains world and
# drives the P1->P5 phase chain on the `genesis-v2` kanban board. Modernizes
# scripts/genesis.sh: Multiverse reset (reset-proc-lab.py), mapcatalog rcon,
# specialist profiles + read-only Steward instead of the wide landfolk roster.
#
# commands:
#   new-run  --seed <int> [--world genesis2] [--model <id>]
#   check                         # print phase gates
#   snapshot [--label <name>]
#   status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Source the repo-local .env so launched bodies inherit PAPERMCP_TOKEN. Without
# it paperMcpConfig() returns null and the crafting server-side fallback — the
# fix for the mineflayer/Paper 1.21 3x3 table-craft window race (#3399) — can't
# fire, so ~half of all tool crafts silently produce nothing. genesis-v2 bypasses
# hermescraft.sh (which sources this), which is exactly why it was lost here.
if [ -f "$REPO_ROOT/.env" ]; then set -a; . "$REPO_ROOT/.env"; set +a; fi
PY="$REPO_ROOT/.venv/bin/python3"           # needs mapcatalog + pyyaml
MC_HOST="${MC_HOST:-192.168.1.202}"
MC_PORT="${MC_PORT:-25565}"

# body roster: user:apiport:viewerport (matches genesis2_lib.BODIES)
BODIES=("Mox:3007:4007" "Pip:3005:4005" "Zee:3006:4006")

# Bring up one body as a HEALTHY connected bot. If it's already connected,
# leave it. Otherwise clear any stale holder of the port (orphan bot from a
# crashed run blocks the new one) and launch fresh.
ensure_body() {
  local user="$1" port="$2" viewer="$3"
  if curl -s "http://127.0.0.1:$port/" 2>/dev/null | grep -q '"connected":true'; then
    return 0
  fi
  for pid in $(lsof -ti ":$port" 2>/dev/null); do
    kill "$pid" 2>/dev/null && echo "[genesis-v2] cleared stale holder $pid on :$port"
  done
  sleep 2
  echo "[genesis-v2] starting body $user on :$port"
  local log="/tmp/$(echo "$user" | tr '[:upper:]' '[:lower:]')-bot.log"
  (cd "$REPO_ROOT" && API_PORT="$port" VIEWER_PORT="$viewer" BOT_MOVEMENT_PROFILE=slow \
     MC_HOST="$MC_HOST" MC_PORT="$MC_PORT" MC_USERNAME="$user" \
     nohup node bot/server.js > "$log" 2>&1 &)
}

# Block until every body reports connected. Hard-fail (exit 1) if not — never
# proceed with a half-broken roster, which is what made the first boot messy.
wait_bodies_connected() {
  for i in $(seq 1 25); do
    local all_ok=1
    for b in "${BODIES[@]}"; do
      local port="${b#*:}"; port="${port%%:*}"
      curl -s "http://127.0.0.1:$port/" 2>/dev/null | grep -q '"connected":true' || all_ok=0
    done
    [[ "$all_ok" == 1 ]] && { echo "[genesis-v2] all bodies connected"; return 0; }
    sleep 4
  done
  echo "[genesis-v2] FATAL: not all bodies connected after 100s — aborting" >&2
  for b in "${BODIES[@]}"; do
    local u="${b%%:*}" port="${b#*:}"; port="${port%%:*}"
    echo "  $u :$port -> $(curl -s "http://127.0.0.1:$port/" 2>/dev/null | head -c 80)" >&2
  done
  exit 1
}

cmd="${1:-}"; shift || true

case "$cmd" in
  new-run)
    SEED=""; WORLD="genesis2"; MODEL="deepseek/deepseek-v4-flash:exacto"; SPAWN=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --seed) SEED="$2"; shift 2 ;;
        --seed=*) SEED="${1#--seed=}"; shift ;;
        --world) WORLD="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        # Operator-pinned spawn: skip the probe/biome/flatness reroll and anchor
        # the colony at these coords (must be valid land in this seed's world).
        --spawn) SPAWN="$2"; shift 2 ;;
        --spawn=*) SPAWN="${1#--spawn=}"; shift ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
      esac
    done
    [[ -n "$SEED" ]] || { echo "--seed <int> required" >&2; exit 1; }

    # Clean the agent layer before booting: stop the prior poller, kill orphaned
    # gateway workers (they don't self-reap and would act on the about-to-be-
    # archived board), and bounce the gateway with --replace so it restarts with
    # NO stale workers, a cleared dispatch task, and the current kanban.failure_limit.
    # The board is archived + reseeded below, so the fresh gateway dispatches only
    # this run's cards. (Localhost single-project; authorised to bounce the gateway.)
    echo "[genesis-v2] clean shutdown: prior poller + stale workers + gateway"
    for pid in $(pgrep -f 'genesis-v2-poller' 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    for pid in $(pgrep -f 'tui_gateway.slash_worker' 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    nohup hermes gateway run --replace >> "$HOME/.hermes/logs/gateway.log" 2>&1 &
    sleep 6

    echo "[genesis-v2] minting specialist profiles (model=$MODEL)"
    "$SCRIPT_DIR/genesis-v2-mint-profiles.sh" --model "$MODEL"

    echo "[genesis-v2] ensuring 3 bodies are up"
    for b in "${BODIES[@]}"; do
      u="${b%%:*}"; rest="${b#*:}"; p="${rest%%:*}"; v="${rest##*:}"
      ensure_body "$u" "$p" "$v"
    done
    wait_bodies_connected

    echo "[genesis-v2] reset + probe + setup + seed (world=$WORLD seed=$SEED spawn=${SPAWN:-auto})"
    GV2_WORLD="$WORLD" GV2_SEED="$SEED" GV2_SPAWN="$SPAWN" exec "$PY" - <<'PYEOF'
import os, sys
sys.path.insert(0, os.path.join(os.getcwd(), "scripts"))
import genesis2_lib as g2

world = os.environ["GV2_WORLD"]
seed = int(os.environ["GV2_SEED"])
spawn_arg = (os.environ.get("GV2_SPAWN") or "").strip()
run_id = g2.next_run_id()
print(f"[genesis-v2] run {run_id}")

if spawn_arg:
    # Operator-pinned spawn: reset the world to the seed, then anchor the colony
    # at the given coords — skip the find_good_spawn probe/biome/flatness reroll.
    # The operator vouches for the site (it must be valid land in this seed).
    sx, sy, sz = (int(v) for v in spawn_arg.split(","))
    g2.reset_world(world=world, seed=seed)
    g2.restart_bodies()  # reset wedges mineflayer — clean restart beats auto-reconnect
    spawn = {"x": sx, "y": sy, "z": sz}
    print(f"[genesis-v2] operator-pinned spawn @ {spawn} (seed={seed})")
else:
    # Reset + probe with auto-reroll: keep regenerating until the natural spawn is
    # a flat, temperate LAND biome (not ocean/frozen/desert/mountain) — a colony
    # needs wood + liquid water + buildable ground. find_good_spawn resets+restarts
    # bodies each attempt and returns the seed it settled on (may differ from
    # --seed if the original rolled a bad spawn).
    seed, spawn = g2.find_good_spawn(world, seed)
    print(f"[genesis-v2] natural land spawn @ {spawn} (seed={seed})")
g2.wipe_marks()  # clean map — drop stale waypoints from prior runs
# Clean-slate the lease pool: a prior run's worker may have leaked a lease (died
# without `mc bot release`), which would lock that body for this run too. Start empty.
_freed = g2.clear_pool_leases()
if _freed:
    print(f"[genesis-v2] cleared {len(_freed)} stale pool lease(s) from prior runs: {[f['bot'] for f in _freed]}")
ctx_pre = {
    "run_id": run_id, "seed": str(seed),
    "spawn_x": str(spawn["x"]), "spawn_y": str(spawn["y"]), "spawn_z": str(spawn["z"]),
    "started_at": g2.gl._iso_utc(),
}
g2.wipe_world_mines(world)
g2.render_regions_world(spawn=spawn, ctx=ctx_pre)
g2.world_setup(world, spawn)

g2.reinit_board()
ctx = {
    "run_id": run_id, "seed": str(seed),
    "spawn_x": str(spawn["x"]), "spawn_y": str(spawn["y"]), "spawn_z": str(spawn["z"]),
    "started_at": g2.gl._iso_utc(),
}
meta = g2.seed_board(ctx)
cfg = {"run_id": run_id, "world": world, "seed": seed, "spawn": spawn,
       "started_at": ctx["started_at"], **meta}
g2.save_config(cfg)
g2.write_active(run_id)
g2.snapshot("start", run_id)

import subprocess

# No gate-check / landfolk-dispatcher: the BOT LEASE is the body-mutex now (one
# lease per body, atomic, with --near ranking + defer). The hermes gateway
# auto-dispatches ready cards concurrently; each lease-mode worker checks out a
# distinct free body via `mc bot checkout`, so same-expertise cards (e.g. the 4
# scout cards) run in PARALLEL across the pool and any excess defers. (Gate-check
# would re-serialize them per assignee — the opposite of what we want here.)

# phase poller: gate-completes epics on verified world state + snapshots
poller = os.path.join(os.getcwd(), "scripts", "genesis-v2-poller.py")
log = open(g2.run_dir(run_id) / "poller.log", "a")
proc = subprocess.Popen([sys.executable, poller, "--run-id", run_id],
                        stdout=log, stderr=subprocess.STDOUT, cwd=os.getcwd())
(g2.run_dir(run_id) / "poller.pid").write_text(str(proc.pid))

print(f"[genesis-v2] run {run_id} live: world={world} spawn={spawn} "
      f"epics={len(meta['epic_ids'])} scout_cards={len(meta['scout_ids'])}")
print(f"[genesis-v2] lease-mutex (no gate-check); gateway dispatch + poller started")
PYEOF
    ;;

  check)
    exec "$PY" -c "
import sys; sys.path.insert(0,'$REPO_ROOT/scripts')
import genesis2_lib as g2, json
print(json.dumps(g2.check_phases(), indent=2))
"
    ;;

  snapshot)
    LABEL="manual"
    [[ "${1:-}" == "--label" ]] && LABEL="$2"
    exec "$PY" -c "
import sys; sys.path.insert(0,'$REPO_ROOT/scripts')
import genesis2_lib as g2
rid = g2.active_run_id()
assert rid, 'no active run'
print(g2.snapshot('$LABEL', rid))
"
    ;;

  status)
    exec "$PY" -c "
import sys; sys.path.insert(0,'$REPO_ROOT/scripts')
import genesis2_lib as g2, json
rid = g2.active_run_id()
print('active run:', rid)
if rid:
    print(json.dumps(g2.load_config(rid), indent=2))
"
    ;;

  *) echo "usage: genesis-v2.sh {new-run --seed <int> [--world W] [--model M] [--spawn X,Y,Z]|check|snapshot|status}" >&2; exit 1 ;;
esac
