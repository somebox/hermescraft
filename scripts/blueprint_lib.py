"""Shared blueprint library helpers (Python). Mirror of bot/lib/runtime/blueprints/*.js."""
from __future__ import annotations

import os
import re
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


def normalize_block_id(raw: str) -> str:
    s = (raw or "").strip().lower().replace(" ", "_").replace("-", "_")
    s = re.sub(r"[^a-z0-9_]", "", s)
    prev = None
    while s != prev:
        prev = s
        s = STRIP_SUFFIX_RE.sub("", s)
    return s or "unknown"


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
