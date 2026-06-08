from __future__ import annotations

import hashlib
import math
import random
from typing import TYPE_CHECKING

from mapcatalog.models import Arena, PlacementSpec
from mapcatalog.probe import blocks_match_batch

if TYPE_CHECKING:
    from mapcatalog.metrics import ProbeMetrics
    from mapcatalog.rcon_protocol import RconClient

NON_STANDABLE = frozenset(
    {
        "water",
        "lava",
        "fire",
        "cactus",
        "sweet_berry_bush",
        "powder_snow",
    }
)


def placement_rng(seed: str, requirements_id: str, name: str) -> random.Random:
    digest = hashlib.sha256(f"{seed}:placement:{requirements_id}:{name}".encode()).hexdigest()
    return random.Random(int(digest[:16], 16))


def _disc_feet_candidates(arena: Arena, rng: random.Random) -> list[tuple[int, int]]:
    cx, cz = arena.center
    r = arena.radius
    r2 = r * r
    pts: list[tuple[int, int]] = []
    for _ in range(512):
        x = rng.randint(cx - r, cx + r)
        z = rng.randint(cz - r, cz + r)
        if (x - cx) ** 2 + (z - cz) ** 2 <= r2:
            pts.append((x, z))
    return pts


def _find_surface_y(
    client: RconClient,
    world: str,
    x: int,
    z: int,
    *,
    y_lo: int = 48,
    y_hi: int = 319,
) -> int | None:
    from mapcatalog.probe import classify_air_probe_line

    for y in range(y_hi, y_lo - 1, -1):
        out = client.run(f"execute in {world} if block {x} {y} {z} #minecraft:air")
        kind = classify_air_probe_line(out)
        if kind == "solid":
            return y + 1
        if kind == "oob":
            continue
    return None


def _is_standable(
    client: RconClient,
    world: str,
    x: int,
    feet_y: int,
    z: int,
    *,
    radius: int,
) -> bool:
    from mapcatalog.probe import line_indicates_block_match

    def foot_ok(fx: int, fy: int, fz: int) -> bool:
        out_f = client.run(
            f"execute in {world} if block {fx} {fy - 1} {fz} #minecraft:air"
        )
        out_h = client.run(f"execute in {world} if block {fx} {fy} {fz} #minecraft:air")
        out_a = client.run(f"execute in {world} if block {fx} {fy + 1} {fz} #minecraft:air")
        if line_indicates_block_match(out_f):
            return False
        if not line_indicates_block_match(out_h):
            return False
        if not line_indicates_block_match(out_a):
            return False
        return True

    if not foot_ok(x, feet_y, z):
        return False
    if radius <= 0:
        return True
    for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        fy = _find_surface_y(client, world, x + dx, z + dz)
        if fy is None or not foot_ok(x + dx, fy, z + dz):
            return False
    return True


def _dist_blocks(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)


def _dist_xz_cells(a: tuple[int, int], b: tuple[int, int]) -> float:
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) / 16.0


def _near_target_points(
    spec: PlacementSpec,
    metrics: ProbeMetrics,
) -> tuple[bool, list[tuple[int, int, int]]]:
    """Resolve anchor cells for ``near block`` / ``near gate`` modifiers.

    Returns ``(required, points)``. When ``required`` is True and ``points`` is
    empty, no candidate can satisfy the modifier — placement must reject.
    """
    if spec.near_block:
        block = spec.near_block
        if not block.startswith("minecraft:"):
            block = f"minecraft:{block}"
        return True, list(metrics.ore_hits.get(block, []))

    if spec.near_gate:
        name = spec.near_gate
        if name == "flat_patch":
            pts = [
                (c.x, c.surface_y, c.z)
                for c in metrics.columns
                if c.surface_y is not None
            ]
            return True, pts
        block = name if name.startswith("minecraft:") else f"minecraft:{name}"
        return True, list(metrics.ore_hits.get(block, []))

    return False, []


def resolve_placements(
    *,
    client: RconClient,
    world: str,
    arena: Arena,
    seed: str,
    requirements_id: str,
    specs: list[PlacementSpec],
    metrics: ProbeMetrics,
) -> tuple[dict[str, list[int]], list[str]]:
    resolved: dict[str, list[int]] = {}
    errors: list[str] = []

    for spec in specs:
        if spec.method == "offset_from":
            parent = spec.offset_from or ""
            if parent not in resolved:
                errors.append(f"placement {spec.name} unreachable")
                continue
            ox, oy, oz = spec.offset or (0, 0, 0)
            px, py, pz = resolved[parent]
            resolved[spec.name] = [px + ox, py + oy, pz + oz]
            continue

        if spec.method == "flat_patch_center":
            cols = [c for c in metrics.columns if c.surface_y is not None]
            if not cols:
                errors.append(f"placement {spec.name} unreachable")
                continue
            cx = int(sum(c.x for c in cols) / len(cols))
            cz = int(sum(c.z for c in cols) / len(cols))
            sy = _find_surface_y(client, world, cx, cz)
            if sy is None:
                errors.append(f"placement {spec.name} unreachable")
                continue
            resolved[spec.name] = [cx, sy, cz]
            continue

        if spec.method != "random_safe":
            errors.append(f"placement {spec.name} unknown method {spec.method}")
            continue

        rng = placement_rng(seed, requirements_id, spec.name)
        attempts = spec.attempts or 32
        radius = spec.radius or 0
        near_required, near_points = _near_target_points(spec, metrics)
        if near_required and not near_points:
            errors.append(f"{spec.name} unreachable")
            continue

        within = spec.within or 8.0
        unit = spec.within_unit or "blocks"

        candidates = _disc_feet_candidates(arena, rng)
        rng.shuffle(candidates)
        found: list[int] | None = None
        for x, z in candidates[:attempts]:
            feet_y = _find_surface_y(client, world, x, z)
            if feet_y is None:
                continue
            if spec.in_biome:
                from mapcatalog.metrics import probe_biome_cell

                if not probe_biome_cell(client, world, x, feet_y, z, spec.in_biome):
                    continue
            if near_required:
                pt = (x, feet_y, z)
                if unit == "cells":
                    ok = any(_dist_xz_cells((x, z), (p[0], p[2])) <= within for p in near_points)
                else:
                    ok = any(_dist_blocks(pt, p) <= within for p in near_points)
                if not ok:
                    continue
            if not _is_standable(client, world, x, feet_y, z, radius=radius):
                continue
            found = [x, feet_y, z]
            break
        if found is None:
            errors.append(f"{spec.name} unreachable")
        else:
            resolved[spec.name] = found

    return resolved, errors


def placement_reject_reasons(errors: list[str]) -> list[str]:
    out: list[str] = []
    for e in errors:
        if e.startswith("placement "):
            out.append(e)
        elif e.endswith(" unreachable"):
            out.append(f"placement {e}")
        else:
            out.append(f"placement {e} unreachable")
    return out
