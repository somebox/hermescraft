"""Surface / underground / entity inspection via batched rcon."""

from __future__ import annotations

import math
import re
from typing import Any

from .config_params import resolve_map
from .rcon import ProceduralRcon
from .timing import TimingReport

WATER_BLOCKS = frozenset(
    {
        "minecraft:water",
        "minecraft:flowing_water",
        "minecraft:lava",
        "minecraft:flowing_lava",
    }
)
GRASS_SURFACE = frozenset(
    {
        "minecraft:grass_block",
        "minecraft:dirt",
        "minecraft:podzol",
        "minecraft:mycelium",
        "minecraft:short_grass",
        "minecraft:tall_grass",
    }
)
LOG_BLOCKS = frozenset(
    {
        "minecraft:oak_log",
        "minecraft:birch_log",
        "minecraft:spruce_log",
        "minecraft:jungle_log",
        "minecraft:acacia_log",
        "minecraft:dark_oak_log",
        "minecraft:cherry_log",
        "minecraft:mangrove_log",
    }
)

MOB_INSPECT_TYPES = (
    "chicken",
    "cow",
    "pig",
    "sheep",
    "zombie",
    "skeleton",
    "creeper",
    "spider",
)

BIOME_PROBES = [
    "minecraft:plains",
    "minecraft:forest",
    "minecraft:birch_forest",
    "minecraft:taiga",
    "minecraft:meadow",
    "minecraft:river",
    "minecraft:ocean",
    "minecraft:desert",
    "minecraft:savanna",
    "minecraft:swamp",
]


def _clip_sample(x: int, z: int, map_cfg: dict[str, Any]) -> bool:
    cx, cz = map_cfg["center_x"], map_cfg["center_z"]
    return math.hypot(x - cx, z - cz) <= map_cfg["border_radius"] + 0.5


def _find_surface_y(
    rcon: ProceduralRcon,
    world: str,
    x: int,
    z: int,
    y_min: int = 40,
    y_max: int = 120,
) -> tuple[int | None, str | None]:
    """Scan downward with batched if-block checks; return top solid Y and block id."""
    cmds = []
    for y in range(y_max, y_min - 1, -1):
        cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:stone run say SURF {x} {y} {z} stone")
        cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:grass_block run say SURF {x} {y} {z} grass_block")
        cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:water run say SURF {x} {y} {z} water")
        cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:dirt run say SURF {x} {y} {z} dirt")
        cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:sand run say SURF {x} {y} {z} sand")
    out = rcon.run_batch(cmds)
    for line in out.splitlines():
        if line.startswith("SURF ") or "SURF " in line:
            parts = line.split()
            try:
                idx = parts.index("SURF")
                y = int(parts[idx + 2])
                kind = parts[idx + 3]
                return y, kind
            except (ValueError, IndexError):
                continue
    return None, None


def _batch_surface_heights_fast(
    rcon: ProceduralRcon,
    world: str,
    points: list[tuple[int, int]],
    y_levels: list[int],
) -> dict[tuple[int, int], tuple[int | None, str | None]]:
    """For each (x,z), find highest y in y_levels where block is not air."""
    result: dict[tuple[int, int], tuple[int | None, str | None]] = {
        p: (None, None) for p in points
    }
    for y in sorted(y_levels, reverse=True):
        cmds = []
        for x, z in points:
            cmds.append(f"execute in {world} if block {x} {y} {z} #minecraft:air run say MISS")
            cmds.append(
                f"execute in {world} unless block {x} {y} {z} #minecraft:air "
                f"run say HIT {x} {y} {z}"
            )
        out = rcon.run_batch(cmds)
        for line in out.splitlines():
            if line.startswith("HIT "):
                parts = line.split()
                if len(parts) >= 4:
                    x, yv, z = int(parts[1]), int(parts[2]), int(parts[3])
                    if result.get((x, z), (None, None))[0] is None:
                        result[(x, z)] = (yv, "solid")
    return result


def _largest_flat_area(
    heights: dict[tuple[int, int], int | None],
    flat_max_dy: int,
) -> dict[str, Any]:
    """Connected components on grid where |dy| <= flat_max_dy between neighbors."""
    cells = [(xz, h) for xz, h in heights.items() if h is not None]
    if not cells:
        return {"area": 0, "centroid_x": 0, "centroid_z": 0, "surface_y": 64}

    remaining = {xz: h for xz, h in cells}
    best: list[tuple[int, int]] = []
    while remaining:
        start = next(iter(remaining))
        base_h = remaining[start]
        stack = [start]
        component: list[tuple[int, int]] = []
        seen = {start}
        while stack:
            cur = stack.pop()
            if cur not in remaining:
                continue
            h = remaining[cur]
            if abs(h - base_h) > flat_max_dy:
                continue
            component.append(cur)
            x, z = cur
            for nbr in ((x + 1, z), (x - 1, z), (x, z + 1), (x, z - 1)):
                if nbr in remaining and nbr not in seen:
                    seen.add(nbr)
                    stack.append(nbr)
        for c in component:
            remaining.pop(c, None)
        if len(component) > len(best):
            best = component
    if not best:
        return {"area": 0, "centroid_x": 0, "centroid_z": 0, "surface_y": 64}
    sx = sum(p[0] for p in best) / len(best)
    sz = sum(p[1] for p in best) / len(best)
    sy = int(round(sum(heights[p] for p in best if heights.get(p) is not None) / len(best)))
    return {
        "area": len(best),
        "centroid_x": int(round(sx)),
        "centroid_z": int(round(sz)),
        "surface_y": sy,
    }


def _terrain_difficulty(heights: dict[tuple[int, int], int | None]) -> float:
    deltas: list[float] = []
    for (x, z), h in heights.items():
        if h is None:
            continue
        for nx, nz in ((x + 1, z), (x, z + 1)):
            nh = heights.get((nx, nz))
            if nh is not None:
                deltas.append(abs(h - nh))
    return round(sum(deltas) / len(deltas), 3) if deltas else 0.0


def _parse_scoreboard_count(out: str, holder: str = "#probe") -> int | None:
    for line in out.splitlines():
        m = re.search(rf"{re.escape(holder)} has (\d+)", line)
        if m:
            return int(m.group(1))
    return None


def _count_mobs_in_region(
    rcon: ProceduralRcon,
    world: str,
    x1: int,
    y1: int,
    z1: int,
    x2: int,
    y2: int,
    z2: int,
) -> dict[str, int]:
    dx, dy, dz = max(0, x2 - x1), max(0, y2 - y1), max(0, z2 - z1)
    sel = f"x={x1},y={y1},z={z1},dx={dx},dy={dy},dz={dz}"
    cmds = ["scoreboard objectives add proc_ent dummy"]
    for mob in MOB_INSPECT_TYPES:
        holder = f"#{mob}"
        cmds.append(f"execute in {world} run scoreboard players set {holder} proc_ent 0")
        cmds.append(
            f"execute in {world} run execute as @e[type={mob},{sel}] "
            f"run scoreboard players add {holder} proc_ent 1"
        )
        cmds.append(f"scoreboard players get {holder} proc_ent")
    out = rcon.run_batch(cmds)
    counts: dict[str, int] = {}
    for mob in MOB_INSPECT_TYPES:
        n = _parse_scoreboard_count(out, f"#{mob}")
        counts[mob] = n if n is not None else 0
    return counts


def run_inspect(
    rcon: ProceduralRcon,
    world: str,
    params: dict[str, Any],
    timing: TimingReport | None = None,
    *,
    seed: int | None = None,
    fixture_id: str | None = None,
    profile: str | None = None,
) -> dict[str, Any]:
    map_cfg = resolve_map(params)
    insp = params.get("inspect") or {}
    step = int(insp.get("grid_step", 16))
    flat_max_dy = int(insp.get("flat_max_dy", 1))
    cx, cz = map_cfg["center_x"], map_cfg["center_z"]
    half = map_cfg["arena_half"]

    points: list[tuple[int, int]] = []
    x = cx - half
    while x <= cx + half:
        z = cz - half
        while z <= cz + half:
            if _clip_sample(x, z, map_cfg):
                points.append((x, z))
            z += step
        x += step

    y_levels = list(range(118, 39, -4))
    heights_raw = _batch_surface_heights_fast(rcon, world, points, y_levels)
    heights: dict[tuple[int, int], int | None] = {p: h[0] for p, h in heights_raw.items()}

    water_n = grass_n = 0
    valid = 0
    for p in points:
        y, kind = heights_raw.get(p, (None, None))
        if y is None:
            continue
        valid += 1
        x, z = p
        detail_cmds = [
            f"execute in {world} if block {x} {y} {z} minecraft:water run say W",
            f"execute in {world} if block {x} {y} {z} minecraft:grass_block run say G",
        ]
        out = rcon.run_batch(detail_cmds)
        if any("W" in ln for ln in out.splitlines()):
            water_n += 1
        if any("G" in ln for ln in out.splitlines()):
            grass_n += 1

    ys = [h for h in heights.values() if h is not None]
    flat = _largest_flat_area(heights, flat_max_dy)
    terrain_diff = _terrain_difficulty(heights)

    biome_hits: dict[str, int] = {}
    if insp.get("biome_sample", True):
        bio_cmds = []
        for x, z in points[:: max(1, len(points) // 32)]:
            y = heights.get((x, z)) or 64
            for bid in BIOME_PROBES:
                bio_cmds.append(
                    f"execute in {world} positioned {x} {y} {z} if biome {bid} run say BIOME {bid}"
                )
        bout = rcon.run_batch(bio_cmds)
        for line in bout.splitlines():
            if "BIOME " in line:
                bid = line.split("BIOME ", 1)[-1].strip()
                biome_hits[bid] = biome_hits.get(bid, 0) + 1

    ug = insp.get("underground") or {}
    coal = iron = cave_air = 0
    if ug.get("enabled", True):
        uy0, uy1 = int(ug.get("y_min", -32)), int(ug.get("y_max", 48))
        ust = int(ug.get("step", 16))
        ug_cmds = []
        for x in range(cx - half, cx + half + 1, ust):
            for z in range(cz - half, cz + half + 1, ust):
                if not _clip_sample(x, z, map_cfg):
                    continue
                for y in range(uy0, uy1 + 1, ust):
                    ug_cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:coal_ore run say C")
                    ug_cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:iron_ore run say I")
                    ug_cmds.append(f"execute in {world} if block {x} {y} {z} minecraft:cave_air run say A")
        uout = rcon.run_batch(ug_cmds)
        coal = uout.count("C")
        iron = uout.count("I")
        cave_air = uout.count("A")

    rt = params.get("runtime") or {}
    adv_ticks = int(insp.get("advance_time_ticks", 0))
    adv_wait = float(insp.get("advance_time_wait_s", 0))
    ent_cmds = []
    if adv_ticks > 0:
        ent_cmds.append(f"execute in {world} run time add {adv_ticks}")
    if ent_cmds:
        rcon.run_batch(ent_cmds)
    if adv_wait > 0:
        import time

        time.sleep(adv_wait)

    x1, z1 = cx - half, cz - half
    x2, z2 = cx + half, cz + half
    y1, y2 = 50, 120
    mob_counts = _count_mobs_in_region(rcon, world, x1, y1, z1, x2, y2, z2)
    hostile = sum(mob_counts.get(m, 0) for m in ("zombie", "skeleton", "creeper", "spider"))
    passive = sum(mob_counts.get(m, 0) for m in ("chicken", "cow", "pig", "sheep"))

    spawn_y = flat["surface_y"] + 1
    spawn_feet = {
        "x": flat["centroid_x"],
        "y": spawn_y,
        "z": flat["centroid_z"],
    }
    muster = dict(spawn_feet)
    floor_y = flat["surface_y"]
    work_bbox = {
        "x1": cx - half,
        "y1": floor_y,
        "z1": cz - half,
        "x2": cx + half,
        "y2": floor_y + 16,
        "z2": cz + half,
    }
    cleanup_bbox = {
        "x1": cx - half,
        "y1": floor_y + 1,
        "z1": cz - half,
        "x2": cx + half,
        "y2": floor_y + 16,
        "z2": cz + half,
    }

    metrics = {
        "prep": {
            "largest_flat_area": flat["area"],
            "grass_pct": round(grass_n / valid, 4) if valid else 0.0,
            "walkable_spawn_near_flat": flat["area"] >= 4,
        },
        "survey": {
            "unique_biome_count": len(biome_hits),
            "biome_hits": biome_hits,
            "tree_log_proxy": 0,
        },
        "transit": {
            "terrain_difficulty": terrain_diff,
            "water_pct": round(water_n / valid, 4) if valid else 0.0,
            "surface_y_std": round(
                (sum((y - sum(ys) / len(ys)) ** 2 for y in ys) / len(ys)) ** 0.5, 3
            )
            if ys
            else 0.0,
        },
        "work": {
            "coal_ore_samples": coal,
            "iron_ore_samples": iron,
            "chicken_count": mob_counts.get("chicken", 0),
            "mobs": mob_counts,
            "mob_passive_total": passive,
            "mob_hostile_total": hostile,
            "mob_total": sum(mob_counts.values()),
        },
        "closeout": {
            "return_flat_area": flat["area"],
            "muster": muster,
        },
        "surface": {
            "water_pct": round(water_n / valid, 4) if valid else 0.0,
            "grass_pct": round(grass_n / valid, 4) if valid else 0.0,
            "surface_y_min": min(ys) if ys else None,
            "surface_y_max": max(ys) if ys else None,
            "surface_y_mean": round(sum(ys) / len(ys), 2) if ys else None,
        },
        "underground": {"coal_ore": coal, "iron_ore": iron, "cave_air_samples": cave_air},
        "runtime": {
            "difficulty": str(rt.get("difficulty", "peaceful")),
            "mob_spawning": bool(rt.get("mob_spawning", True)),
        },
    }

    fingerprint_inputs = {
        "fixture_id": fixture_id,
        "seed": seed,
        "mc_version": params.get("mc_version"),
        "map": map_cfg,
        "spawn_feet": spawn_feet,
    }

    return {
        "world": world,
        "seed": seed,
        "fixture_id": fixture_id,
        "profile": profile or params.get("profile"),
        "map": map_cfg,
        "params": params,
        "metrics": metrics,
        "metrics_by_shape": metrics,
        "spawn_feet": spawn_feet,
        "muster": muster,
        "work_bbox": work_bbox,
        "cleanup_bbox": cleanup_bbox,
        "fingerprint_inputs": fingerprint_inputs,
    }
