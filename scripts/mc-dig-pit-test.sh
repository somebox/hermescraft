#!/usr/bin/env bash
# Scratch a small pit beside the bot (server-side dig_area), via mc HTTP API.
#
# 1) If the bot is deep vs local terrain columns (terrain_top radius), tries mc goto_near
#    toward the surface, then pillar_step (pillar/cave/cliff escape).
# 2) Finds top solid Y at pit column (terrain_top + small XZ offsets; radius fallback).
# 3) One mc dig_area for the bounding box (layer radius + depth).
#
# Env:
#   MC_API_URL              default http://127.0.0.1:3001
#   MC_HTTP_LONG_ACTION_MS  raise if mc dig_area times out while the server still digs
#   SKIP_SURFACE_ESC        if 1/true — skip climb-out phase
#   SURFACE_Y_GAP           floor(bot Y) must be below feetYHint from terrain_top by this much (default 1)
#   SURFACE_SCAN_RADIUS     mc terrain_top radius for local surface (default 64, max 32 API cap → use 32)
#   SURFACE_GOTO_RANGE      mc goto_near range arg (default 4)
#   SURFACE_ESCAPE_TRIES    different XZ columns to try as goto targets (default 9)
#   SURFACE_PILLAR_STEPS    after goto, mc pillar_step attempts (default 16)
#   SURFACE_PILLAR_BLOCK    optional block name for pillar_step
#   SURFACE_FORCE_ESC       if 1/true — force escape logic even when Y gap looks small
#   PIT_DEPTH               blocks downward (default 4)
#   PIT_SIDE                column east offset from floor(bot X) (default 2). Also accepts plain SIDE=…
#   PIT_LAYER_RADIUS        horizontal Chebyshev radius around pit center column (default 0)
#   PIT_COLUMN_FALLBACK_REACH  if exact column is empty, mc terrain_top radius from intended column (default 14)
#   PIT_EQUIP               optional item for mc equip before digging
#   PIT_ABORT_ON_DIG_FAIL   if 1/true — pass abort_on_fail to dig_area (default: continue on skip)
#   PIT_CLEAR_STAND         if 1/true (default) — dig_area clear_stand (nudge off stand block per layer)
#   PIT_PICKUP               if 0/false — dig_area pickup false
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MC_API_URL="${MC_API_URL:-http://127.0.0.1:3001}"
export PATH="$ROOT/bin:${PATH}"

DEPTH="${PIT_DEPTH:-4}"
SIDE="${PIT_SIDE:-${SIDE:-2}}"
LAYER_RADIUS="${PIT_LAYER_RADIUS:-0}"
# terrain_top radius is capped at 32 in the API
SURFACE_TOP_R="${SURFACE_SCAN_RADIUS:-64}"
if [[ "${SURFACE_TOP_R}" -gt 32 ]]; then SURFACE_TOP_R=32; fi
export SURFACE_TOP_R
COL_FALLBACK_R="${PIT_COLUMN_FALLBACK_REACH:-14}"
if [[ "${COL_FALLBACK_R}" -gt 32 ]]; then COL_FALLBACK_R=32; fi

if ! command -v mc >/dev/null 2>&1; then
  echo "mc not found; expected $ROOT/bin/mc"
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "${TMP:-}"' EXIT

echo "  Bot API: $MC_API_URL"
mc status --json >"$TMP" || { echo "  status failed — is npm start running in bot/?"; exit 1; }

attempt_surface_escape() {
  local st="$1"
  if [[ "${SKIP_SURFACE_ESC:-0}" =~ ^(1|true|yes)$ ]]; then
    echo "  Surface escape: skipped (SKIP_SURFACE_ESC)"
    return 0
  fi
  export SURFACE_Y_GAP="${SURFACE_Y_GAP:-1}"
  export SURFACE_GOTO_RANGE="${SURFACE_GOTO_RANGE:-4}"
  export SURFACE_ESCAPE_TRIES="${SURFACE_ESCAPE_TRIES:-9}"
  export SURFACE_PILLAR_STEPS="${SURFACE_PILLAR_STEPS:-16}"
  export SURFACE_PILLAR_BLOCK="${SURFACE_PILLAR_BLOCK:-}"
  export SURFACE_FORCE_ESC="${SURFACE_FORCE_ESC:-0}"
  python3 - "$st" <<'PY'
import json, math, os, pathlib, subprocess, sys

def mc_goto_near(x, y, z, grange: int) -> bool:
    r = subprocess.run(
        ["mc", "goto_near", str(int(x)), str(int(y)), str(int(z)), str(int(grange)), "--json"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return False
    try:
        env = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return False
    return bool(env.get("ok"))


def mc_refresh_status(path: pathlib.Path) -> bool:
    r = subprocess.run(["mc", "status", "--json"], capture_output=True, text=True)
    if r.returncode != 0:
        return False
    path.write_text(r.stdout or "{}")
    return True


def fy_from_status(raw):
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw or {}
    pos = data.get("position") or {}
    return int(math.floor(float(pos["y"]))) if pos.get("y") is not None else None


def mc_pillar_step(block_name: str) -> bool:
    cmd = ["mc", "pillar_step", "--json"]
    if block_name:
        cmd = ["mc", "pillar_step", block_name, "--json"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return False
    try:
        env = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return False
    return bool(env.get("ok"))


def mc_terrain_top(ix: int, iz: int, radius: int):
    r = subprocess.run(
        ["mc", "terrain_top", str(ix), str(iz), str(int(radius)), "--json"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return None
    try:
        raw = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return None
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    return data if isinstance(data, dict) else None


st = pathlib.Path(sys.argv[1])
raw = json.load(st.open())
data = raw.get("data") if isinstance(raw.get("data"), dict) else raw or {}
dim = str(data.get("dimension") or "overworld").replace("minecraft:", "")

pos = data.get("position") or {}
if not all(k in pos for k in ("x", "y", "z")):
    print("  Surface escape: no position in status — skip", file=sys.stderr)
    sys.exit(0)

px = float(pos["x"])
py = float(pos["y"])
pz = float(pos["z"])
fy = int(math.floor(py))

if dim != "overworld":
    print(f"  Surface escape: skip (dimension {dim})", file=sys.stderr)
    sys.exit(0)

y_gap = float(os.environ.get("SURFACE_Y_GAP", "1"))
r_scan = int(os.environ.get("SURFACE_TOP_R", "32"))
g_range = int(os.environ.get("SURFACE_GOTO_RANGE", "4"))
max_tries = int(os.environ.get("SURFACE_ESCAPE_TRIES", "9"))
force_escape = str(os.environ.get("SURFACE_FORCE_ESC", "0")).lower() in ("1", "true", "yes")

ix, iz = int(math.floor(px)), int(math.floor(pz))


def hdist(lx, lz):
    return math.hypot(lx - px, lz - pz)


reg = mc_terrain_top(ix, iz, r_scan)
if not reg or reg.get("topY") is None:
    print("  Surface escape: terrain_top failed — skip climb", file=sys.stderr)
    sys.exit(0)

feet_hint = reg.get("feetYHint")
top_y = int(reg["topY"])
if feet_hint is None:
    feet_hint = top_y + 1
else:
    feet_hint = int(feet_hint)

delta = feet_hint - fy
if delta < y_gap and not force_escape:
    print(
        f"  Surface escape: bot feet≈Y{fy}, local surface feet≈{feet_hint} (Δ={delta}); no climb (<{y_gap})",
        file=sys.stderr,
    )
    sys.exit(0)
if delta < y_gap and force_escape:
    print(
        f"  Surface escape: forcing climb despite small gap (bot≈Y{fy}, surface≈{feet_hint}, Δ={delta})",
        file=sys.stderr,
    )

print(
    f"  Surface escape: bot Y≈{fy} vs surface feet≈{feet_hint} (Δ={delta}); goto_near / pillar…",
    file=sys.stderr,
)

# Build waypoint columns: regional max column first, then offsets with per-column terrain_top
cx = int(reg.get("columnX", ix))
cz = int(reg.get("columnZ", iz))
tiles = [(cx, top_y, cz)]

offsets = [
    (0, 0),
    (8, 0), (-8, 0), (0, 8), (0, -8),
    (16, 0), (-16, 0), (0, 16), (0, -16),
]
seen = {(cx, cz)}
for ox, oz in offsets:
    tx, tz = ix + ox, iz + oz
    if (tx, tz) in seen:
        continue
    seen.add((tx, tz))
    col = mc_terrain_top(tx, tz, 0)
    if col and col.get("topY") is not None:
        tiles.append((tx, int(col["topY"]), tz))
    if len(tiles) >= max_tries:
        break

tiles.sort(key=lambda t: (-t[1], hdist(float(t[0]), float(t[2]))))

target_floor_y = feet_hint
if force_escape:
    target_floor_y = max(target_floor_y, fy + 1)
pillar_max = int(os.environ.get("SURFACE_PILLAR_STEPS", "16"))
pill_block = (os.environ.get("SURFACE_PILLAR_BLOCK") or "").strip()

ok_any = False
for tx, ty, tz in tiles[:max_tries]:
    label = f"({tx},{ty},{tz}), range={g_range}"
    print(f"  Surface escape: try goto_near {label}", file=sys.stderr)
    if mc_goto_near(tx, ty, tz, g_range):
        print(f"  Surface escape: reached near {label}", file=sys.stderr)
        ok_any = True
        break

if not ok_any:
    print("  Surface escape: no goto waypoint reached — trying pillar_step anyway…", file=sys.stderr)

mc_refresh_status(st)
raw_live = json.load(st.open())
fy_live = fy_from_status(raw_live) or fy
escaped = False

if fy_live >= target_floor_y:
    print(f"  Surface escape: usable height at floor Y≈{fy_live} (need ≥{target_floor_y})", file=sys.stderr)
    escaped = True

if not escaped:
    print(
        f"  Surface escape: pillar (≤{pillar_max}) from Y≈{fy_live} toward ≈{target_floor_y}…",
        file=sys.stderr,
    )
    stalled_steps = 0
    for step in range(pillar_max):
        mc_refresh_status(st)
        raw3 = json.load(st.open())
        fy_cur = fy_from_status(raw3)
        if fy_cur is None:
            print("  Surface escape: pillar stopped (no position)", file=sys.stderr)
            break
        if fy_cur >= target_floor_y:
            print(f"  Surface escape: pillar ok (Y≈{fy_cur})", file=sys.stderr)
            escaped = True
            break
        print(f"  Surface escape: pillar_step #{step + 1}/{pillar_max} (Y≈{fy_cur})…", file=sys.stderr)
        if not mc_pillar_step(pill_block):
            print("  Surface escape: pillar_step failed", file=sys.stderr)
            break
        mc_refresh_status(st)
        raw_after = json.load(st.open())
        fy_after = fy_from_status(raw_after)
        if fy_after is not None and fy_after <= fy_cur:
            stalled_steps += 1
            if stalled_steps >= 2:
                print("  Surface escape: stalled — stop pillar", file=sys.stderr)
                break
        else:
            stalled_steps = 0

mc_refresh_status(st)
raw_final = json.load(st.open())
fy_final = fy_from_status(raw_final)
if fy_final is not None and fy_final >= target_floor_y:
    escaped = True

if not escaped:
    print(
        f"  Surface escape: failed (Y≈{fy_final}, need ≥{target_floor_y}); abort pit.",
        file=sys.stderr,
    )
    sys.exit(4)

sys.exit(0)
PY
}

attempt_surface_escape "$TMP"

if [[ -n "${PIT_EQUIP:-}" ]]; then
  echo "  Pre-equip: mc equip ${PIT_EQUIP} …"
  mc equip "${PIT_EQUIP}" --json || echo "  (equip failed — dig may skip hard blocks)"
fi

mc status --json >"$TMP" || { echo "  status refresh failed"; exit 1; }

ABORT_FAIL="false"
[[ "${PIT_ABORT_ON_DIG_FAIL:-0}" =~ ^(1|true|yes)$ ]] && ABORT_FAIL="true"
CLEAR_STAND="true"
[[ "${PIT_CLEAR_STAND:-1}" =~ ^(0|false|no)$ ]] && CLEAR_STAND="false"
DO_PICKUP="true"
[[ "${PIT_PICKUP:-1}" =~ ^(0|false|no)$ ]] && DO_PICKUP="false"

export COL_FALLBACK_R SIDE DEPTH LAYER_RADIUS
export ENV_TMP="$TMP"

if ! PIT_VARS="$(
  python3 <<'PY'
import json, math, os, pathlib, subprocess, sys

def mc_columns(ix: int, iz: int, radius: int):
    r = subprocess.run(
        ["mc", "terrain_top", str(ix), str(iz), str(int(radius)), "--json"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        return None
    try:
        raw = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return None
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    if not isinstance(data, dict) or data.get("topY") is None:
        return None
    return data


tmp = pathlib.Path(os.environ["ENV_TMP"])
raw = json.load(tmp.open())
body = raw.get("data") if isinstance(raw.get("data"), dict) else raw
pos = (body or {}).get("position") or {}
if not all(k in pos for k in ("x", "y", "z")):
    sys.stderr.write("missing position\n")
    sys.exit(2)

x = float(pos["x"])
z = float(pos["z"])
floor_y = int(math.floor(float(pos["y"])))
side = int(os.environ["SIDE"])
sx = int(math.floor(x) + side)
sz = int(math.floor(z))
reach = int(os.environ["COL_FALLBACK_R"])

hit = None
for ox, oz in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
    tx, tz = sx + ox, sz + oz
    col = mc_columns(tx, tz, 0)
    if col:
        hit = (tx, tz, int(col["topY"]))
        break

if hit is None:
    col = mc_columns(sx, sz, reach)
    if col:
        hit = (int(col.get("columnX", sx)), int(col.get("columnZ", sz)), int(col["topY"]))
        sys.stderr.write(f"  Pit column: fallback radius {reach} → X={hit[0]} Z={hit[1]} top≈Y{hit[2]}\n")

if hit is None:
    sys.stderr.write("no terrain_top near pit offset; try PIT_SIDE / move bot.\n")
    sys.exit(3)

SX, SZ, BASE_Y = hit
print(f"SX={SX};SZ={SZ};BASE_Y={BASE_Y};FLOOR_Y={floor_y}")
PY
)"; then
  echo "  Pit locate failed." >&2
  exit 1
fi
eval "$PIT_VARS"

echo "  Bot feet tier≈$FLOOR_Y; pit center X=$SX Z=$SZ top Y=$BASE_Y; depth=$DEPTH layer_r=$LAYER_RADIUS"

x1=$((SX - LAYER_RADIUS))
x2=$((SX + LAYER_RADIUS))
z1=$((SZ - LAYER_RADIUS))
z2=$((SZ + LAYER_RADIUS))
y_top=$BASE_Y
y_bot=$((BASE_Y - DEPTH + 1))

DIG_JSON="$(
  python3 -c '
import json, sys
x1, y1, z1, x2, y2, z2, pickup, abort, clear = sys.argv[1:]
print(json.dumps({
    "x1": int(x1), "y1": int(y1), "z1": int(z1),
    "x2": int(x2), "y2": int(y2), "z2": int(z2),
    "pickup": pickup == "true",
    "abort_on_fail": abort == "true",
    "clear_stand": clear == "true",
}))
' \
    "$x1" "$y_top" "$z1" "$x2" "$y_bot" "$z2" "$DO_PICKUP" "$ABORT_FAIL" "$CLEAR_STAND"
)"

echo "  mc dig_area box X[$x1..$x2] Y[$y_bot..$y_top] Z[$z1..$z2] …"
mc dig_area "$DIG_JSON" --json

echo "  Done. Pit ~ center $SX,$SZ from Y=$y_bot .. $y_top. Inspect: mc scene"
