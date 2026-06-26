"""Starter_shelter fixture policy — policy compliance, not blanket in-footprint bans.

Aligns offline audits with ``verify.js`` fixture-aware construct-end: chests/crafting
tables/furnaces in interior air cells are intended when they match this policy.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from scripts.lib.gv2_schematic_shelter import footprint_min_from_base_anchor

# Mirrors bot/lib/runtime/blueprints/compare.js FIXTURE_NAMES (structural blocks excluded).
_FIXTURE_BLOCK_RE = re.compile(
    r"^(chest|trapped_chest|ender_chest|furnace|blast_furnace|smoker|barrel|"
    r"crafting_table|cartography_table|smithing_table|fletching_table|loom|"
    r"stonecutter|grindstone|lectern|brewing_stand|enchanting_table|anvil|"
    r"chipped_anvil|damaged_anvil|bell|campfire|soul_campfire|bookshelf|jukebox|"
    r"note_block|composter|cauldron|beehive|bee_nest)(?:_|$)",
    re.I,
)

ALLOWED_MARK_FIXTURES = frozenset({"chest_wood", "chest_food"})
# Fixtures may be placed after the schematic shell phases (L4_roof) or the dedicated chest card.
ALLOWED_AFTER_PHASES = frozenset({"L4_roof", "chest_depot"})


def _normalize_block(name: str) -> str:
    s = str(name or "").strip().lower().replace("-", "_")
    if s.startswith("minecraft:"):
        s = s.split(":", 1)[1]
    return s


def is_policy_fixture_block(name: str) -> bool:
    n = _normalize_block(name)
    if _FIXTURE_BLOCK_RE.match(n):
        return True
    if n.endswith("_bed") or n == "bed":
        return True
    return False


def expected_chest_depot_coords(base_anchor: dict[str, int]) -> dict[str, tuple[int, int, int]]:
    """World coords for chest_wood / chest_food (on L1 slab surface, interior column)."""
    ax, ay, az = int(base_anchor["x"]), int(base_anchor["y"]), int(base_anchor["z"])
    slab_y = ay  # feet y == L1 slab plane; chests sit on top (ay + 1)
    return {
        "chest_wood": (ax - 1, slab_y + 1, az),
        "chest_food": (ax - 1, slab_y + 1, az + 1),
    }


def _load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text()) if path.is_file() else None
    except (json.JSONDecodeError, OSError):
        return None


def _schematic_context(run_root: Path) -> bool:
    cfg = _load_json(run_root / "config.json") or {}
    if cfg.get("schematic_shelter_bootstrapped") or cfg.get("schematic_shelter_cards"):
        return True
    return (run_root / "rendered" / "starter_shelter-plan.json").is_file()


def audit_starter_shelter_fixtures(
    run_root: Path,
    locations: dict[str, Any] | None = None,
    *,
    base_snapshot: dict | None = None,
) -> dict[str, Any]:
    """Compare shared marks and optional snapshot blocks to the depot policy."""
    if not _schematic_context(run_root):
        return {"present": False, "ok": True, "violations": [], "expected": {}}

    loc = locations or {}
    cfg = _load_json(run_root / "config.json") or {}
    anchor_mark = loc.get("base_anchor") if isinstance(loc.get("base_anchor"), dict) else None
    if not anchor_mark:
        return {"present": True, "ok": False, "violations": ["no base_anchor mark"], "expected": {}}

    base_anchor = {
        "x": int(anchor_mark["x"]),
        "y": int(anchor_mark["y"]),
        "z": int(anchor_mark["z"]),
    }
    expected = expected_chest_depot_coords(base_anchor)
    violations: list[str] = []

    for mark, (ex, ey, ez) in expected.items():
        m = loc.get(mark)
        if not isinstance(m, dict) or m.get("stale"):
            violations.append(f"mark missing or stale: {mark}")
            continue
        if int(m["x"]) != ex or int(m["y"]) != ey or int(m["z"]) != ez:
            violations.append(
                f"mark {mark} drift: got ({m['x']},{m['y']},{m['z']}) expected ({ex},{ey},{ez})"
            )

    snap = base_snapshot
    if snap is None:
        snap = _load_json(run_root / "artifacts" / "world" / "base-snapshot.json")
    if isinstance(snap, dict):
        oy = int(snap.get("origin", [0, 0, 0])[1])
        chest_y = oy + 1
        layer = (snap.get("layers") or {}).get(str(chest_y)) or {}
        cells = layer.get("cells") or {}
        for mark, (ex, ey, ez) in expected.items():
            key = f"{ex},{ez}"
            block = cells.get(key)
            if block and "chest" not in _normalize_block(block):
                violations.append(f"snapshot at {mark} cell {key}: {block} (expected chest)")

        ox, oz = int(snap["origin"][0]), int(snap["origin"][2])
        xmin, xmax, zmin, zmax = ox - 3, ox + 3, oz - 3, oz + 3
        for key, block in cells.items():
            if not block or not is_policy_fixture_block(block):
                continue
            try:
                x, z = (int(p) for p in key.split(","))
            except (ValueError, TypeError):
                continue
            if x < xmin or x > xmax or z < zmin or z > zmax:
                continue
            allowed_cells = {(ex, ez) for ex, _, ez in expected.values()}
            if (x, z) not in allowed_cells:
                violations.append(f"fixture {block} at ({x},{chest_y},{z}) outside depot policy cells")

    closed = cfg.get("construct_phase_closed")
    if isinstance(closed, dict) and any(loc.get(m) for m in ALLOWED_MARK_FIXTURES):
        if not closed.get("L4_roof"):
            violations.append("fixture marks set but L4_roof construct phase not closed")

    return {
        "present": True,
        "ok": len(violations) == 0,
        "violations": violations,
        "expected": {k: list(v) for k, v in expected.items()},
        "allowed_marks": sorted(ALLOWED_MARK_FIXTURES),
        "allowed_after_phases": sorted(ALLOWED_AFTER_PHASES),
    }
