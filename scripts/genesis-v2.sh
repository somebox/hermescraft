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
    SEED=""; WORLD="genesis2"; MODEL="deepseek/deepseek-v4-flash:exacto"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --seed) SEED="$2"; shift 2 ;;
        --seed=*) SEED="${1#--seed=}"; shift ;;
        --world) WORLD="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        *) echo "unknown flag: $1" >&2; exit 1 ;;
      esac
    done
    [[ -n "$SEED" ]] || { echo "--seed <int> required" >&2; exit 1; }

    echo "[genesis-v2] minting specialist profiles (model=$MODEL)"
    "$SCRIPT_DIR/genesis-v2-mint-profiles.sh" --model "$MODEL"

    echo "[genesis-v2] ensuring 3 bodies are up"
    for b in "${BODIES[@]}"; do
      u="${b%%:*}"; rest="${b#*:}"; p="${rest%%:*}"; v="${rest##*:}"
      ensure_body "$u" "$p" "$v"
    done
    wait_bodies_connected

    echo "[genesis-v2] reset + probe + setup + seed (world=$WORLD seed=$SEED)"
    GV2_WORLD="$WORLD" GV2_SEED="$SEED" exec "$PY" - <<'PYEOF'
import os, sys
sys.path.insert(0, os.path.join(os.getcwd(), "scripts"))
import genesis2_lib as g2

world = os.environ["GV2_WORLD"]
seed = int(os.environ["GV2_SEED"])
run_id = g2.next_run_id()
print(f"[genesis-v2] run {run_id}")

g2.reset_world(world=world, seed=seed)
g2.wipe_marks()  # clean map — drop stale waypoints from prior runs
spawn = g2.probe_natural_spawn(world)  # colony anchors at the bodies' natural land spawn
print(f"[genesis-v2] natural land spawn @ {spawn}")
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

# Park sibling cards BEFORE any dispatcher (gateway included) can grab them —
# closes the initial-seed race where multiple same-bot cards are all ready and
# unparked at once. Parks persist across ticks, so this one call is enough to
# establish the per-bot mutex invariant immediately.
subprocess.run(["hermes", "landfolk", "gate-check", "--board", "genesis-v2"],
               cwd=os.getcwd(), capture_output=True, text=True, timeout=30)

# Canonical stack dispatcher: gate-check (per-bot mutex via [bot:] tags) THEN
# dispatch. This is what serializes work per body — the bare hermes gateway
# skips gate-check, which is what let multiple workers pile onto one bot.
disp_env = {**os.environ, "BOARD": "genesis-v2", "INTERVAL": "10", "MAX": "3"}
disp_log = open(g2.run_dir(run_id) / "dispatcher.log", "a")
disp = subprocess.Popen(["bash", os.path.join(os.getcwd(), "scripts", "landfolk-dispatcher.sh")],
                        stdout=disp_log, stderr=subprocess.STDOUT, cwd=os.getcwd(), env=disp_env)
(g2.run_dir(run_id) / "dispatcher.pid").write_text(str(disp.pid))

# phase poller: gate-completes epics on verified world state + snapshots
poller = os.path.join(os.getcwd(), "scripts", "genesis-v2-poller.py")
log = open(g2.run_dir(run_id) / "poller.log", "a")
proc = subprocess.Popen([sys.executable, poller, "--run-id", run_id],
                        stdout=log, stderr=subprocess.STDOUT, cwd=os.getcwd())
(g2.run_dir(run_id) / "poller.pid").write_text(str(proc.pid))

print(f"[genesis-v2] run {run_id} live: world={world} spawn={spawn} "
      f"epics={len(meta['epic_ids'])} scout_cards={len(meta['scout_ids'])}")
print(f"[genesis-v2] dispatcher (gate-check+dispatch) + poller started")
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

  *) echo "usage: genesis-v2.sh {new-run --seed <int> [--world W] [--model M]|check|snapshot|status}" >&2; exit 1 ;;
esac
