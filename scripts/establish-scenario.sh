#!/usr/bin/env bash
# Bootstrap exploration-first base establishment on proc-lab + landfolk fleet.
#
# Idempotent: stops any running landfolk session first, wipes per-bot memory
# (marks + recent hermes sessions), patches map JSON to align muster with
# the random_safe-validated spawn, seeds starter inventory directly so workers
# don't enter `maintain_food` mode on empty inv.
#
# Env:
#   VARIANT         scenario registry variant (default: establishment.explore)
#   WORKERS         comma list of profiles to start (default: steward,gatherer,flint,mason)
#   SKIP_MEM_WIPE=1 keep per-bot marks/sessions (debugging)
#   SKIP_MAP_PATCH=1 do not collapse muster to spawn (debugging)
#   AUTO_REUSE=0    force re-materialize even if seed matches loaded world
#   MATERIALIZE=0   skip the materialize step entirely (world already prepared)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VARIANT="${VARIANT:-establishment.explore}"
SERVER="${SERVER:-server.local.yaml}"
AUTO_REUSE="${AUTO_REUSE:-1}"
MATERIALIZE="${MATERIALIZE:-1}"
WORKERS="${WORKERS:-steward,gatherer,flint,mason}"
SKIP_MEM_WIPE="${SKIP_MEM_WIPE:-0}"
SKIP_MAP_PATCH="${SKIP_MAP_PATCH:-0}"
PY="${ROOT}/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  PY=python3
fi

export HERMES_KANBAN_BOARD="${HERMES_KANBAN_BOARD:-landfolk-ops}"

echo "== establishment explore bootstrap (board=$HERMES_KANBAN_BOARD) =="

# --- Pre-flight: stop any running landfolk session so the script is idempotent.
if pgrep -f "node server.js\|hermes.*kanban task\|landfolk-dispatcher" >/dev/null 2>&1; then
  echo "== pre-flight: existing landfolk session — stopping =="
  scripts/landfolk stop 2>&1 | grep -E "✓|stopped" | head -8 || true
  # Give listeners a moment to close.
  sleep 2
fi

# --- Memory wipe: clear marks + recent sessions for the worker profiles.
if [[ "$SKIP_MEM_WIPE" != "1" ]]; then
  echo "== wipe per-bot memory ($WORKERS) =="
  IFS=',' read -ra _WK <<< "$WORKERS"
  for wk in "${_WK[@]}"; do
    locs="$ROOT/data/locations-${wk}.json"
    if [[ -f "$locs" ]]; then
      echo "  marks: $locs"
      rm -f "$locs"
    fi
    prof="$HOME/.hermes/profiles/${wk}/sessions"
    if [[ -d "$prof" ]]; then
      count=$(find "$prof" -maxdepth 1 -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
      if [[ "$count" -gt 0 ]]; then
        echo "  sessions: $prof ($count files)"
        find "$prof" -maxdepth 1 -type f -name "*.json" -delete 2>/dev/null || true
      fi
    fi
  done
  # Also clear the catch-all locations file used by some bot startup paths.
  rm -f "$ROOT/data/locations-base.json"
fi

"$PY" -m mapcatalog scenario lint --only "$VARIANT"

CATALOG_DIR="$("$PY" -c "
from mapcatalog.scenario_registry import load_registry, variant_by_id
v = variant_by_id(load_registry(), '$VARIANT')
print(v.catalog_dir if v else '')
")"

if [[ -n "$CATALOG_DIR" ]] && ! compgen -G "${CATALOG_DIR}/*.json" >/dev/null 2>&1; then
  echo "== empty catalog; refresh $VARIANT =="
  scripts/scenario-pools.sh refresh --only "$VARIANT" -s "$SERVER" --allow-partial || true
fi

MAP_JSON="$(mktemp)"
trap 'rm -f "$MAP_JSON"' EXIT
if ! scripts/scenario-pools.sh map "$VARIANT" >"$MAP_JSON"; then
  echo "No map in catalog — try TRY_SEED or refresh first." >&2
  exit 1
fi
mkdir -p "$ROOT/data/runtime"
cp "$MAP_JSON" "$ROOT/data/runtime/last-establish-map.json"
SEED="$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['seed'])" "$MAP_JSON")"
echo "seed=$SEED map=data/runtime/last-establish-map.json"

# --- Auto-patch: muster and starter_chest derived by `offset_from spawn` are
# not validated as standable — on terrain with relief they end up buried.
# Collapse muster onto spawn (validated random_safe) and put the chest 1 east
# at the same Y as spawn-feet (sy). Run-8 evidence: prior convention `sy-1`
# placed the chest BLOCK flush with the grass row — top at bot-feet level,
# visually "in the ground." Standard Minecraft placed chests sit ON the
# surface (block bottom at feet-Y, top sticking up one block). Patches both
# the temp map and the persisted copy so downstream scripts (seed-cards,
# tp_workers, check, prep) see the same coords.
if [[ "$SKIP_MAP_PATCH" != "1" ]]; then
  echo "== patch map: muster=spawn, chest at spawn-feet level =="
  for target in "$MAP_JSON" "$ROOT/data/runtime/last-establish-map.json"; do
    "$PY" -c "
import json, sys
p = sys.argv[1]
m = json.loads(open(p).read())
sx, sy, sz = m['placements']['spawn']
m['placements']['muster'] = [sx, sy, sz]
m['muster'] = [sx, sy, sz]
m['placements']['starter_chest'] = [sx+1, sy, sz]
m['starter_chest'] = [sx+1, sy, sz]
open(p, 'w').write(json.dumps(m, indent=2))
print(f\"  {p}: spawn={[sx,sy,sz]} muster=spawn chest={[sx+1,sy,sz]}\")
" "$target"
  done
fi

if [[ "$MATERIALIZE" == "1" ]]; then
  SKIP_MAT=0
  if [[ "$AUTO_REUSE" == "1" ]]; then
    if "$PY" -c "
from mapcatalog.proc_state import seed_matches_loaded
from mapcatalog.server_config import load_server_config
from pathlib import Path
import sys
cfg = load_server_config(Path('$SERVER'))
sys.exit(0 if seed_matches_loaded(cfg.world_name, sys.argv[1]) else 1)
" "$SEED"; then
      echo "== AUTO_REUSE: proc-lab already seed $SEED — skip mapcatalog try =="
      SKIP_MAT=1
    fi
  fi
  if [[ "$SKIP_MAT" -eq 0 ]]; then
    "$PY" scripts/establish-materialize.py --map "$MAP_JSON" -s "$SERVER"
  fi
fi

echo "== rcon prep (peaceful + starter chest) =="
"$PY" scripts/establish-rcon-prep.py --map "$MAP_JSON" --mode world

WORKERS="${WORKERS:-steward,gatherer,flint,mason}"

# Phase 6 (2026-06-02): the gateway hosts the kanban dispatcher
# (config: kanban.dispatch_in_gateway=true). Start it before the workers
# so ready cards get picked up immediately. `run --replace` is idempotent
# — kills any prior gateway and starts a fresh one.
# See docs/features/procedural-planning.md Phase 6.
echo "== hermes gateway run (idempotent) =="
nohup hermes gateway run --replace >/dev/null 2>&1 &
disown 2>/dev/null || true
# Give the gateway a moment to bind its port + start the dispatcher loop.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if hermes gateway status 2>/dev/null | grep -q "running"; then break; fi
  sleep 1
done

echo "== landfolk start ($WORKERS) =="
scripts/landfolk-control.sh start --profiles "$WORKERS"

echo "== wait for bot listeners (each up to 60s) =="
declare -A WORKER_PORTS=( [steward]=3005 [gatherer]=3001 [flint]=3002 [mason]=3003 [barley]=3004 )
IFS=',' read -ra _WK <<< "$WORKERS"
for wk in "${_WK[@]}"; do
  port="${WORKER_PORTS[$wk]:-}"
  if [[ -z "$port" ]]; then echo "  $wk: no port mapping — skipping wait"; continue; fi
  for i in $(seq 1 60); do
    if curl -s -m 1 "http://localhost:$port/status" >/dev/null 2>&1; then
      echo "  $wk up on :$port (${i}s)"; break
    fi
    sleep 1
    if [[ $i -eq 60 ]]; then echo "  $wk: listener never came up on :$port (continuing)"; fi
  done
done

echo "== tp workers into proc-lab @ muster + starter inventory =="
"$PY" scripts/establish-rcon-prep.py --map "$MAP_JSON" --mode tp_workers --workers "$WORKERS"

# Settle so positions/inventories propagate to the bot HTTP layer.
sleep 4

# --- Position sanity check: re-tp any worker that landed Underground.
echo "== verify worker positions (re-tp if Underground) =="
SX=$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['placements']['spawn'][0])" "$MAP_JSON")
SY=$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['placements']['spawn'][1])" "$MAP_JSON")
SZ=$("$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))['placements']['spawn'][2])" "$MAP_JSON")
for wk in "${_WK[@]}"; do
  port="${WORKER_PORTS[$wk]:-}"
  if [[ -z "$port" ]]; then continue; fi
  sit=$(curl -s -m 2 "http://localhost:$port/status?lean=true" 2>/dev/null \
    | "$PY" -c "import json,sys; d=json.loads(sys.stdin.read()).get('data',{}); print((d.get('nav_header') or {}).get('situation',''))" 2>/dev/null)
  if [[ "$sit" == "Underground" || "$sit" == "Pit" ]]; then
    name=$(echo "$wk" | "$PY" -c "import sys; print(sys.stdin.read().strip().capitalize())")
    echo "  $wk landed $sit — re-tp to spawn ($SX,$SY,$SZ)"
    "$PY" -c "
import importlib.util
from pathlib import Path
ROOT = Path('$ROOT')
spec = importlib.util.spec_from_file_location('at', ROOT/'scripts'/'agent-test.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.run_rcon_batch(['execute in proc-lab run tp $name $SX $SY $SZ'])
"
  else
    echo "  $wk: $sit"
  fi
done

RUN_ID="establish-$(date -u +%Y-%m-%dT%H%M%SZ)"
echo "== reset kanban ($RUN_ID) =="
"$PY" -c "
import sys
from datetime import datetime
sys.path.insert(0, 'scripts')
import genesis_lib as gl
rid = sys.argv[1]
gl.archive_run_state(rid)
gl.reinit_kanban_board()
" "$RUN_ID"

echo "== seed kanban epic + explore cards =="
"$PY" scripts/establish-seed-cards.py --map "$MAP_JSON"

cat <<EOF

Bootstrap complete.
  Board:  scripts/kanban board
  Grade:  scripts/establish-check.py
  Logs:   tail -F logs/landfolk-*/steward.log logs/landfolk-*/gatherer.log
  Stop:   scripts/landfolk stop

PR-1 scene bench (manual):
  BOT_URL=http://localhost:3002 scripts/proc-lab-ops.sh agent-only

EOF
