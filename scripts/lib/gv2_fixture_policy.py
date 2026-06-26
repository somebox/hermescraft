"""Starter_shelter fixture policy — policy compliance, not blanket in-footprint bans.

Aligns offline audits with ``verify.js`` fixture-aware construct-end: chests/crafting
tables/furnaces in interior air cells are intended when they match this policy.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from scripts.lib.gv2_schematic_shelter import (
    footprint_min_from_base_anchor,
    staging_depot_candidate_coords,
)

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
    """Compare shared marks and optional snapshot blocks to the depot policy.

    Findings are TIERED (a functional 1-block shift must not read like a chest in a wall):
      - blocked: wrong level (y), far drift, non-chest where a chest is expected, a
        fixture in a wall/perimeter cell, or fixtures placed before L4_roof closes.
      - warn:    a cosmetic in-interior shift, a not-yet-placed depot mark, or a reachable
        non-canonical interior fixture once the shell is up.
    ``ok`` fails only on a BLOCKED finding (the pilot gate trips on real problems, not
    cosmetic drift). The staging depot at spawn is excluded by construction."""
    base = {"present": True, "ok": True, "violations": [], "warnings": [], "findings": []}
    if not _schematic_context(run_root):
        return {**base, "present": False, "expected": {}}

    loc = locations or {}
    cfg = _load_json(run_root / "config.json") or {}
    anchor_mark = loc.get("base_anchor") if isinstance(loc.get("base_anchor"), dict) else None
    if not anchor_mark:
        return {**base, "ok": False, "violations": ["no base_anchor mark"],
                "findings": [{"severity": "blocked", "detail": "no base_anchor mark"}],
                "expected": {}}

    ax, ay, az = int(anchor_mark["x"]), int(anchor_mark["y"]), int(anchor_mark["z"])
    base_anchor = {"x": ax, "y": ay, "z": az}
    expected = expected_chest_depot_coords(base_anchor)
    findings: list[dict[str, str]] = []

    def add(severity: str, detail: str) -> None:
        findings.append({"severity": severity, "detail": detail})

    chest_y = ay + 1                 # slab surface (where base chests sit)
    fmin, fmax_x, fmax_z = ax - 3, ax + 3, az + 3  # 7×7 footprint edges (= walls)
    fmin_z = az - 3

    def _interior_slab(x: int, y: int, z: int) -> bool:
        return (y == chest_y and (ax - 2) <= x <= (ax + 2) and (az - 2) <= z <= (az + 2))

    # Staging depot lives at spawn and MUST clear the shelter footprint. If its candidate
    # cell falls inside the footprint, that is the overlap the depot lifecycle forbids —
    # flag it (do NOT silently skip it, which would mask a real chest-in-footprint).
    spawn = cfg.get("spawn") if isinstance(cfg.get("spawn"), dict) else None
    if spawn:
        sx, _sy, sz = staging_depot_candidate_coords(spawn)
        if fmin <= sx <= fmax_x and fmin_z <= sz <= fmax_z:
            add("blocked", f"staging depot ({sx},{sz}) overlaps shelter footprint — relocate base or depot")

    # Only judge "fixtures before the shell closed" when the run actually tracks phase
    # closure; absent tracking ⇒ give the benefit of the doubt (no premature-placement block).
    phase_tracking = isinstance(cfg.get("construct_phase_closed"), dict)
    l4_closed = bool((cfg.get("construct_phase_closed") or {}).get("L4_roof"))

    # --- mark drift tiering ---
    for mark, (ex, ey, ez) in expected.items():
        m = loc.get(mark)
        if not isinstance(m, dict) or m.get("stale"):
            add("warn", f"mark missing or stale: {mark}")
            continue
        mx, my, mz = int(m["x"]), int(m["y"]), int(m["z"])
        if (mx, my, mz) == (ex, ey, ez):
            continue
        if my != ey:
            add("blocked", f"mark {mark} drift (wrong level): got ({mx},{my},{mz}) expected ({ex},{ey},{ez})")
        elif abs(mx - ex) <= 1 and abs(mz - ez) <= 1 and _interior_slab(mx, my, mz):
            add("warn", f"mark {mark} cosmetic drift: got ({mx},{my},{mz}) expected ({ex},{ey},{ez})")
        else:
            add("blocked", f"mark {mark} drift: got ({mx},{my},{mz}) expected ({ex},{ey},{ez})")

    # --- snapshot block tiering ---
    snap = base_snapshot
    if snap is None:
        snap = _load_json(run_root / "artifacts" / "world" / "base-snapshot.json")
    if isinstance(snap, dict):
        oy = int(snap.get("origin", [0, 0, 0])[1])
        layer = (snap.get("layers") or {}).get(str(oy + 1)) or {}
        cells = layer.get("cells") or {}
        allowed_cells = {(ex, ez) for ex, _, ez in expected.values()}
        for mark, (ex, ey, ez) in expected.items():
            block = cells.get(f"{ex},{ez}")
            if block and "chest" not in _normalize_block(block):
                add("blocked", f"snapshot at {mark} cell {ex},{ez}: {block} (expected chest)")
        for key, block in cells.items():
            if not block or not is_policy_fixture_block(block):
                continue
            try:
                x, z = (int(p) for p in key.split(","))
            except (ValueError, TypeError):
                continue
            if not (fmin <= x <= fmax_x and fmin_z <= z <= fmax_z):
                continue                          # outside the build footprint
            if (x, z) in allowed_cells:
                continue                          # canonical base chest
            if x in (fmin, fmax_x) or z in (fmin_z, fmax_z):
                add("blocked", f"fixture {block} at ({x},{oy + 1},{z}) in a wall/perimeter cell")
            elif phase_tracking and not l4_closed:
                add("blocked", f"fixture {block} at ({x},{oy + 1},{z}) placed before L4_roof closed")
            else:
                add("warn", f"fixture {block} at ({x},{oy + 1},{z}) interior but not canonical depot")

    if any(loc.get(m) for m in ALLOWED_MARK_FIXTURES) and phase_tracking and not l4_closed:
        add("blocked", "fixture marks set but L4_roof construct phase not closed")

    blocked = [f["detail"] for f in findings if f["severity"] == "blocked"]
    warnings = [f["detail"] for f in findings if f["severity"] == "warn"]
    return {
        "present": True,
        "ok": len(blocked) == 0,
        "violations": blocked,        # back-compat: real (gate-failing) problems
        "warnings": warnings,
        "findings": findings,
        "expected": {k: list(v) for k, v in expected.items()},
        "allowed_marks": sorted(ALLOWED_MARK_FIXTURES),
        "allowed_after_phases": sorted(ALLOWED_AFTER_PHASES),
    }
