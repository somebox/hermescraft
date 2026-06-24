"""Shared blueprint library helpers (Python). Mirror of bot/lib/runtime/blueprints/*.js."""
from __future__ import annotations

import os
import re
from collections import Counter
from typing import Any

STRIP_SUFFIX_RE = re.compile(
    r"(_facing_[a-z0-9_]+|_hinge_[a-z0-9_]+|_unpowered(_[a-z0-9_]+)?|_powered(_[a-z0-9_]+)?"
    r"|_upper|_lower|_head_of_the_bed|_foot_of_the_bed|_normal|_unactive|_active)$",
    re.I,
)

AIR_NAMES = frozenset({"air", "cave_air", "void_air"})

PLAN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


def int_env(name: str, fallback: int) -> int:
    v = os.environ.get(name)
    if v is None:
        return fallback
    try:
        n = int(v)
        return n if n > 0 else fallback
    except ValueError:
        return fallback


MAX_CELLS = int_env("BLUEPRINT_MAX_CELLS", 50_000)
MAX_FOOTPRINT_VOLUME = int_env("BLUEPRINT_MAX_FOOTPRINT_VOLUME", 200_000)
MIN_CELLS = int_env("BLUEPRINT_MIN_CELLS", 1)
VERIFY_MAX = int_env("BLUEPRINT_VERIFY_MAX_CELLS_PER_CALL", 2_000)


def footprint_volume(local: dict[str, list[int]]) -> int:
    dx = local["x"][1] - local["x"][0] + 1
    dy = local["y"][1] - local["y"][0] + 1
    dz = local["z"][1] - local["z"][0] + 1
    return dx * dy * dz


def assert_plan_size(cells_count: int, footprint_local: dict[str, list[int]] | None) -> None:
    if cells_count < MIN_CELLS:
        raise ValueError(f"BLUEPRINT_SIZE_EXCEEDED: {cells_count} cells (min {MIN_CELLS})")
    if cells_count > MAX_CELLS:
        raise ValueError(f"BLUEPRINT_SIZE_EXCEEDED: {cells_count} cells (max {MAX_CELLS})")
    if footprint_local:
        vol = footprint_volume(footprint_local)
        if vol > MAX_FOOTPRINT_VOLUME:
            raise ValueError(f"BLUEPRINT_SIZE_EXCEEDED: footprint volume {vol} (max {MAX_FOOTPRINT_VOLUME})")


def tight_footprint_from_cells(cells: list[dict]) -> dict[str, Any]:
    if not cells:
        return {"mode": "tight", "local": {"x": [0, 0], "y": [0, 0], "z": [0, 0]}}
    xs = [c["local"][0] for c in cells]
    ys = [c["local"][1] for c in cells]
    zs = [c["local"][2] for c in cells]
    return {
        "mode": "tight",
        "local": {"x": [min(xs), max(xs)], "y": [min(ys), max(ys)], "z": [min(zs), max(zs)]},
    }


def metadata_footprint(meta: dict) -> dict[str, Any]:
    w = int(meta.get("width") or 1)
    h = int(meta.get("height") or 1)
    d = int(meta.get("depth") or 1)
    return {"mode": "metadata", "local": {"x": [1, w], "y": [1, h], "z": [1, d]}}


def footprint_mins(footprint: dict) -> tuple[int, int, int]:
    loc = footprint["local"]
    return loc["x"][0], loc["y"][0], loc["z"][0]


def floor_world_y(anchor: list[int], footprint: dict) -> int:
    """World Y of the lowest local layer (foundation / layer 1)."""
    mx, my, _mz = footprint_mins(footprint)
    loc = footprint["local"]
    return int(anchor[1] + (loc["y"][0] - my))


def local_to_world(
    anchor: list[int], footprint: dict, lx: int, ly: int, lz: int
) -> tuple[int, int, int]:
    """World block coords for plan-local (lx, ly, lz). Matches bot footprint.localToWorld."""
    mx, my, mz = footprint_mins(footprint)
    return (
        int(anchor[0] + (lx - mx)),
        int(anchor[1] + (ly - my)),
        int(anchor[2] + (lz - mz)),
    )


def anchor_from_marker(marker: list[int], footprint: dict) -> list[int]:
    """Min-corner anchor: footprint center on marker XZ, floor Y = marker Y."""
    loc = footprint["local"]
    mx, my, mz = footprint_mins(footprint)
    cx = (loc["x"][0] + loc["x"][1]) // 2
    cz = (loc["z"][0] + loc["z"][1]) // 2
    floor_local_y = loc["y"][0]
    return [
        int(marker[0] - (cx - mx)),
        int(marker[1] - (floor_local_y - my)),
        int(marker[2] - (cz - mz)),
    ]


def normalize_block_id(raw: str) -> str:
    s = (raw or "").strip().lower().replace(" ", "_").replace("-", "_")
    s = re.sub(r"[^a-z0-9_]", "", s)
    prev = None
    while s != prev:
        prev = s
        s = STRIP_SUFFIX_RE.sub("", s)
    return s or "unknown"


def is_door_block(block_id: str) -> bool:
    return normalize_block_id(block_id).endswith("_door")


def placement_block_id(block_id: str) -> str:
    """Canonical id stored in plan cells (GrabCraft door halves → oak_door, etc.)."""
    base = normalize_block_id(block_id)
    if base.endswith("_door"):
        return base
    return block_id


def materials_planned_from_cells(cells: list[dict]) -> list[tuple[str, int]]:
    """Supply manifest: normalized ids; one door item per (local x,z) column."""
    counts: Counter = Counter()
    door_at: dict[tuple[int, int], tuple[int, str]] = {}
    for c in cells:
        bid = c["block"]
        base = normalize_block_id(bid)
        lx, ly, lz = c["local"]
        if base.endswith("_door"):
            key = (lx, lz)
            prev = door_at.get(key)
            if prev is None or ly < prev[0]:
                door_at[key] = (ly, base)
            continue
        counts[base] += 1
    for _, door_id in door_at.values():
        counts[door_id] += 1
    return counts.most_common()


def compare_blocks(plan_id: str, world_name: str) -> tuple[bool, str | None]:
    pb = normalize_block_id(plan_id)
    wb = normalize_block_id(world_name)
    if pb == wb:
        return True, None
    if world_name.lower() in AIR_NAMES and pb == "air":
        return True, None
    note = "state_not_verified_v1" if pb != normalize_block_id(plan_id) else None
    return False, note


def slug_from_name(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "plan").lower()).strip("-")
    s = re.sub(r"-+", "-", s)
    if not s or not PLAN_ID_RE.match(s):
        s = "blueprint"
    return s[:41]
