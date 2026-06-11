"""Synthetic terrain fixture builders (Track F).

Each builder returns a dict in the terrain-fixture/v1 schema: per-column
sparse block stacks (solids/liquids only — air is implicit) along a survey
line on the z axis, x strip [-2..2] (path_width 3 + shoulders). Committed
JSON lives in data/fixtures/terrain/*.json so the JS suite reads fixtures
without running Python. Regenerate with:  python -m roadplan.fixtures

Annotations record facts true *by construction* — not K1 policy:
  expected_route_class  natural | stairs | bridge | clearing
  expected_run_kinds    ordered run-kind sequence K1 must reproduce
                        (run *boundaries* are K1 policy; the kind sequence
                        is terrain fact). Kinds: walk, climb, descend,
                        water, gap, trees, clearance.
  deficits              exact obstacles with world coords
  max_runs              hysteresis budget (dither only)
"""
from __future__ import annotations

import json
import random
from pathlib import Path

from .spec import load_spec

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "data" / "fixtures" / "terrain"

SCHEMA = "terrain-fixture/v1"
STRIP_XS = (-2, -1, 0, 1, 2)


def _fixture(name, description, length, columns, annotations, y_hint=64):
    cols = [
        {"x": x, "z": z, "blocks": [[y, b] for y, b in sorted(blocks)]}
        for (x, z), blocks in sorted(columns.items())
    ]
    return {
        "schema": SCHEMA,
        "name": name,
        "description": description,
        "line": {"from": [0, 0], "to": [0, length - 1], "y_hint": y_hint},
        "columns": cols,
        "annotations": annotations,
    }


def _ground_strip(length, surface_y):
    cols = {}
    for z in range(length):
        y = surface_y(z) if callable(surface_y) else surface_y
        for x in STRIP_XS:
            cols[(x, z)] = [(y - 1, "dirt"), (y, "grass_block")]
    return cols


def flat(length=32):
    cols = _ground_strip(length, 64)
    return _fixture("flat", "Level grass plain — walkable as-is.", length, cols, {
        "walkable": True,
        "expected_route_class": "natural",
        "expected_run_kinds": ["walk"],
        "deficits": [],
    })


def ridge(length=32):
    def surface(z):
        if z <= 9:
            return 64
        if z <= 13:
            return 64 + (z - 9)      # 65..68, step 1 each — walkable climb
        if z == 14:
            return 70                # +2 jump — stairs needed
        if z <= 19:
            return 70
        if z <= 23:
            return 70 - (z - 19)     # 69..66, step 1 each
        return 66

    cols = _ground_strip(length, surface)
    return _fixture("ridge", "Climb with one 2-block step; gentle descent.", length, cols, {
        "walkable": False,
        "expected_route_class": "stairs",
        "expected_run_kinds": ["walk", "climb", "walk", "descend", "walk"],
        "deficits": [{"kind": "step", "at": [0, 14], "rise": 2}],
    })


def river(length=32, gap=(14, 17), depth=3):
    cols = _ground_strip(length, 64)
    for z in range(gap[0], gap[1] + 1):
        for x in STRIP_XS:
            floor = 63 - depth
            stack = [(floor, "dirt")]
            stack += [(y, "water") for y in range(floor + 1, 64)]
            cols[(x, z)] = stack
    width = gap[1] - gap[0] + 1
    return _fixture("river", "Water gap inside max_bridge — bridge it.", length, cols, {
        "walkable": False,
        "expected_route_class": "bridge",
        "expected_run_kinds": ["walk", "water", "walk"],
        "deficits": [{
            "kind": "water", "from": [0, gap[0]], "to": [0, gap[1]],
            "width": width, "depth": depth,
        }],
    })


def ravine(length=32, gap=(14, 19)):
    spec = load_spec()
    depth = int(spec["no_floor_min_depth"]) + 2
    cols = _ground_strip(length, 64)
    for z in range(gap[0], gap[1] + 1):
        for x in STRIP_XS:
            cols[(x, z)] = [(64 - depth, "stone")]
    width = gap[1] - gap[0] + 1
    return _fixture("ravine", "No-floor-class chasm — bridge edge only, never a free crossing.",
                    length, cols, {
        "walkable": False,
        "expected_route_class": "bridge",
        "expected_run_kinds": ["walk", "gap", "walk"],
        "deficits": [{
            "kind": "gap", "from": [0, gap[0]], "to": [0, gap[1]],
            "width": width, "depth": depth,
        }],
    })


def forest(length=32):
    cols = _ground_strip(length, 64)
    trees = ((0, 10), (1, 15), (-1, 21))
    for tx, tz in trees:
        cols[(tx, tz)] += [(y, "oak_log") for y in range(65, 69)]
        cols[(tx, tz)].append((69, "oak_leaves"))
        for nx, nz in ((tx - 1, tz), (tx + 1, tz), (tx, tz - 1), (tx, tz + 1)):
            if (nx, nz) in cols:
                cols[(nx, nz)].append((68, "oak_leaves"))
    return _fixture("forest", "Flat ground, three oaks on the swath — fell them.", length, cols, {
        "walkable": False,
        "expected_route_class": "clearing",
        "expected_run_kinds": ["walk", "trees", "walk", "trees", "walk", "trees", "walk"],
        "deficits": [{"kind": "tree", "at": [tx, tz], "base_y": 65} for tx, tz in trees],
    })


def cliff(length=32, edge=16, drop=6):
    cols = _ground_strip(length, lambda z: 64 if z < edge else 64 - drop)
    return _fixture("cliff", "Sheer drop past max_unguarded_drop — steps down needed.",
                    length, cols, {
        "walkable": False,
        "expected_route_class": "stairs",
        "expected_run_kinds": ["walk", "descend", "walk"],
        "deficits": [{"kind": "drop", "at": [0, edge], "drop": drop}],
    })


def dither(length=32, seed=7):
    rng = random.Random(seed)
    ys, y = [], 64
    # Clamp to a range of 2 so no monotone stretch can accumulate a net rise
    # ≥ 2*max_step_up+1 — the single-walk-run annotation is then true by
    # construction, not by noise luck.
    for _ in range(length):
        y = min(66, max(64, y + rng.choice((-1, 0, 1))))
        ys.append(y)
    cols = _ground_strip(length, lambda z: ys[z])
    return _fixture("dither", "±1 noise, every step ≤1 — hysteresis must not fragment runs.",
                    length, cols, {
        "walkable": True,
        "expected_route_class": "natural",
        "expected_run_kinds": ["walk"],
        "max_runs": 3,
        "deficits": [],
    })


def overhang(length=24):
    cols = _ground_strip(length, 64)
    for z in range(8, 16):           # high shelf: gap 65..67 = clearance 3, walkable
        for x in STRIP_XS:
            cols[(x, z)] += [(68, "stone"), (69, "stone")]
    for z in range(18, 21):          # low shelf: gap 65..66 = 2 < clearance_height
        for x in STRIP_XS:
            cols[(x, z)] += [(67, "stone"), (68, "stone")]
    return _fixture("overhang", "Walk surface under rock shelves — surface-pick must choose "
                    "the ground, not the shelf top; low shelf violates clearance.",
                    length, cols, {
        "walkable": False,
        "expected_route_class": "clearing",
        "expected_run_kinds": ["walk", "clearance", "walk"],
        "deficits": [{"kind": "clearance", "from": [0, 18], "to": [0, 20], "height": 2}],
    })


def slab_stairs(length=24):
    def column(z):
        if z <= 7:
            return 64, False
        steps = ((64, True), (65, False), (65, True), (66, False), (66, True), (67, False))
        if z <= 13:
            return steps[z - 8]
        return 67, False

    cols = {}
    for z in range(length):
        g, has_slab = column(z)
        for x in STRIP_XS:
            stack = [(g - 1, "dirt"), (g, "grass_block")]
            if has_slab:
                stack.append((g + 1, "oak_slab"))
            cols[(x, z)] = stack
    return _fixture("slab_stairs", "Ascent via bottom slabs — every effective step ≤1 "
                    "(half-block heights), walkable with no construction.",
                    length, cols, {
        "walkable": True,
        "expected_route_class": "natural",
        "expected_run_kinds": ["walk", "climb", "walk"],
        "deficits": [],
    })


ALL_BUILDERS = (flat, ridge, river, ravine, forest, cliff, dither, overhang, slab_stairs)


# --- sampling adapter (fixture columns -> K2 solver samples) -----------------
# Mirrors the K1 surface-pick semantics (bot/lib/shared/walk-classify.js).
# Cross-language drift between this adapter and K1 is guarded indirectly by
# the route-class goldens; survey_line parity goldens are the strong guard.

_PASSABLE = {
    "air", "cave_air", "void_air", "torch", "wall_torch", "snow", "snow_layer",
    "grass", "short_grass", "tall_grass", "fern", "large_fern", "dead_bush",
}
_FLUIDS = {"water", "flowing_water", "lava", "flowing_lava"}
_VEG_SUFFIXES = ("_log", "_stem", "_leaves", "_wart_block", "_sapling")


def _is_veg(name):
    return name.endswith(_VEG_SUFFIXES)


def _stand_height(y, name):
    return y + 0.5 if name.endswith("_slab") else y + 1


def analyze_column(blocks, ref_height, spec):
    """Surface nearest the walk elevation + water depth + first obstruction."""
    by_y = {y: n for y, n in blocks}
    candidates = []
    for y, name in blocks:
        if name in _FLUIDS or name in _PASSABLE or _is_veg(name):
            continue
        above = by_y.get(y + 1)
        if above and above not in _PASSABLE and above not in _FLUIDS and not _is_veg(above):
            continue
        candidates.append((y, name, _stand_height(y, name)))
    if not candidates:
        return None
    y, name, h = min(candidates, key=lambda c: (abs(c[2] - ref_height), c[2]))
    water_depth = 0
    while by_y.get(y + 1 + water_depth) in _FLUIDS:
        water_depth += 1
    obstruction = None
    feet = -(-h // 1)  # ceil
    for cy in range(int(feet), int(feet) + int(spec["clearance_height"])):
        n = by_y.get(cy)
        if n is None or n in _PASSABLE or n in _FLUIDS:
            continue
        obstruction = "tree" if _is_veg(n) else "clearance"
        break
    return {"block_y": y, "name": name, "height": h,
            "water_depth": water_depth, "obstruction": obstruction}


def samples_from_fixture(fx, spec):
    """Flatten a terrain fixture into solver samples: {x, z, y, kind}."""
    ref = fx["line"]["y_hint"] + 1
    samples = []
    for col in fx["columns"]:
        a = analyze_column(col["blocks"], ref, spec)
        if a is None:
            kind, y = "gap", None
        elif ref - a["height"] >= spec["no_floor_min_depth"]:
            kind, y = "gap", a["height"]
        elif a["water_depth"] > 0:
            kind, y = "water", a["height"]
        elif a["obstruction"]:
            kind, y = a["obstruction"], a["height"]
        else:
            kind, y = "ground", a["height"]
        samples.append({"x": col["x"], "z": col["z"], "y": y, "kind": kind})
    return samples


def build_all():
    return {fx["name"]: fx for fx in (build() for build in ALL_BUILDERS)}


def write_all(out_dir=None):
    out = Path(out_dir) if out_dir else FIXTURE_DIR
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, fx in build_all().items():
        p = out / f"{name}.json"
        p.write_text(json.dumps(fx, indent=1, sort_keys=True) + "\n")
        written.append(p)
    return written


if __name__ == "__main__":
    for p in write_all():
        print(p)
