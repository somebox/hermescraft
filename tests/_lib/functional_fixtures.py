"""Shared world-prep helpers for functional tests (LOS walls, grids, sealed targets).

Centralizes repeated geometry so verb-specific tests stay focused on assertions.
"""

from __future__ import annotations

from typing import Iterable

# Canonical ground arena — matches landfolk-test spawn region geometry.
ARENA_HALF = 32
ARENA_FLOOR_Y = 64
ARENA_FEET_Y = 65
ARENA_AIR_TOP_Y = 80
ARENA_DIRT_BOTTOM_Y = 60
ARENA_STONE_BOTTOM_Y = 50
ARENA_CENTER = (0.0, float(ARENA_FEET_Y), 0.0)

LAB_ZONE = (
    -ARENA_HALF,
    ARENA_FEET_Y,
    -ARENA_HALF,
    -1,
    ARENA_AIR_TOP_Y,
    ARENA_HALF,
)
MINING_ZONE = (
    1,
    ARENA_FEET_Y,
    -ARENA_HALF,
    ARENA_HALF,
    ARENA_AIR_TOP_Y,
    ARENA_HALF,
)
LAB_CENTER = (-16, ARENA_FEET_Y, 0)
MINING_CENTER = (16, ARENA_FEET_Y, 0)


def lay_ground_substrate_session(rcon, world: str) -> None:
    """Session-once: pack stone y=50..59 + forceload the arena region."""
    rcon.batch([
        f"execute in {world} run forceload add -32 -32 32 32",
        f"execute in {world} run fill -32 50 -32 32 59 32 minecraft:stone",
    ])


def ensure_arena_forceload(rcon, world: str) -> None:
    """Re-apply session forceload (fixtures must not call forceload remove all)."""
    rcon.run(f"execute in {world} run forceload add -32 -32 32 32")


def reset_ground_arena(rcon, world: str, *, floor: str = "grass_block") -> None:
    """Per-test reset: restore full canonical substrate in ±32 (y=50..80)."""
    floor_full = floor if ":" in floor else f"minecraft:{floor}"
    rcon.batch([
        f"execute in {world} run fill -32 65 -32 32 80 32 minecraft:air",
        f"execute in {world} run fill -32 50 -32 32 59 32 minecraft:stone",
        f"execute in {world} run fill -32 60 -32 32 63 32 minecraft:dirt",
        f"execute in {world} run fill -32 64 -32 32 64 32 {floor_full}",
        f"execute in {world} run setblock 0 65 -32 minecraft:lapis_block",
        f"execute in {world} run setblock 0 66 -32 minecraft:lapis_block",
        f"execute in {world} run setblock 0 65 32 minecraft:lapis_block",
        f"execute in {world} run setblock 0 66 32 minecraft:lapis_block",
    ])
    ensure_arena_forceload(rcon, world)


def tp_tester_at_origin_facing_west(rcon, world: str) -> None:
    """Park at origin with yaw 90° (MC: west). Used for +X targets at x=2 through obsidian at x=1."""
    rcon.run(f"execute in {world} run tp Tester 0 65 0 90 0")


def tp_tester_at_origin_facing_east(rcon, world: str) -> None:
    """Alias: historical name; same as facing_west (yaw 90). Prefer tp_tester_at_origin_facing_west."""
    tp_tester_at_origin_facing_west(rcon, world)


def place_obsidian_los_wall(
    rcon,
    world: str,
    *,
    wall_x: int = 1,
    wall_y_base: int = 65,
    wall_z: int = 0,
    wall_height: int = 2,
) -> None:
    """Two-block-tall obsidian wall on +X from the bot at (0,65,0) facing east."""
    cmds = []
    for dy in range(wall_height):
        cmds.append(
            f"execute in {world} run setblock {wall_x} {wall_y_base + dy} {wall_z} minecraft:obsidian"
        )
    rcon.batch(cmds)


def prep_standard_los_blocked_target(
    rcon,
    world: str,
    *,
    target_kind: str,
    target_x: int = 2,
    target_y: int = 65,
    target_z: int = 0,
    extra_target_cmds: Iterable[str] | None = None,
) -> None:
    """Bot at (0,65,0), obsidian at x=1, target at (2,65,0) — standard F64–F66 layout."""
    cmds = [
        f"execute in {world} run setblock {target_x} {target_y} {target_z} {target_kind}",
    ]
    if extra_target_cmds:
        cmds.extend(extra_target_cmds)
    place_obsidian_los_wall(rcon, world)
    tp_tester_at_origin_facing_east(rcon, world)
    rcon.batch(cmds)


# Canonical bboxes for new functional tests (see tests/README.md harness post-condition).
ARENA_SMALL = (-8, 64, -8, 8, 80, 8)
ARENA_MEDIUM = (-16, 60, -16, 16, 80, 16)
ARENA_LARGE = (-30, 60, -30, 30, 80, 30)
ARENA_SKY_Y = 200


def arena_small(arena, floor: str = "grass_block") -> None:
    arena.reset_workspace(ARENA_SMALL, floor=floor)


def arena_medium(arena, floor: str = "grass_block", subfloor: str = "stone") -> None:
    arena.reset_workspace(ARENA_MEDIUM, floor=floor, subfloor=subfloor, floor_y=64)


def arena_large(arena, floor: str = "stone") -> None:
    arena.reset_workspace(ARENA_LARGE, floor=floor)


def arena_sky(arena, span: int = 32, floor: str = "stone") -> tuple[int, int, int, int, int, int]:
    half = span // 2
    bbox = (-half, ARENA_SKY_Y - 4, -half, half, ARENA_SKY_Y + 30, half)
    arena.reset_workspace(bbox, floor=floor, floor_y=ARENA_SKY_Y, forceload=True)
    return bbox


def prep_sealed_bedrock_cell(
    rcon,
    world: str,
    *,
    cx: int = 15,
    cy: int = 65,
    cz: int = 15,
) -> None:
    """3×3×4 bedrock shell around (cx,cy,cz) — unreachable interior for timeout tests."""
    rcon.batch([
        f"execute in {world} run fill {cx-1} {cy-1} {cz-1} {cx+1} {cy-1} {cz+1} minecraft:bedrock",
        f"execute in {world} run fill {cx-1} {cy} {cz-1} {cx+1} {cy+3} {cz+1} minecraft:air",
        f"execute in {world} run fill {cx-1} {cy} {cz-1} {cx-1} {cy+2} {cz+1} minecraft:bedrock",
        f"execute in {world} run fill {cx+1} {cy} {cz-1} {cx+1} {cy+2} {cz+1} minecraft:bedrock",
        f"execute in {world} run fill {cx-1} {cy} {cz-1} {cx+1} {cy+2} {cz-1} minecraft:bedrock",
        f"execute in {world} run fill {cx-1} {cy} {cz+1} {cx+1} {cy+2} {cz+1} minecraft:bedrock",
        f"execute in {world} run fill {cx-1} {cy+3} {cz-1} {cx+1} {cy+3} {cz+1} minecraft:bedrock",
        f"execute in {world} run setblock {cx-1} {cy+1} {cz} minecraft:glass",
        f"execute in {world} run setblock {cx-1} {cy+2} {cz} minecraft:glass",
    ])


def bake_prefabs_session(arena) -> list[str]:
    """Build canonical prefabs once at session start; return prefab names baked."""
    rcon = arena.rcon
    world = arena.world
    pad = (40, 64, -8, 56, 67, 8)
    rcon.batch([
        f"execute in {world} run fill {pad[0]} {pad[1]} {pad[2]} "
        f"{pad[3]} {pad[4]} {pad[5]} minecraft:air",
    ])

    cmds = []
    for x in range(0, 5, 2):
        for z in range(0, 5, 2):
            cmds.append(
                f"execute in {world} run setblock {40 + x} 65 {z} minecraft:cobblestone"
            )
    rcon.batch(cmds)
    arena.save_prefab("mining_grid_3x3", (40, 65, 0, 44, 65, 4))

    rcon.batch([
        f"execute in {world} run setblock 46 65 0 minecraft:obsidian",
        f"execute in {world} run setblock 46 66 0 minecraft:obsidian",
    ])
    arena.save_prefab("los_wall", (46, 65, 0, 46, 66, 0))

    cx, cy, cz = 48, 65, 4
    rcon.batch([
        f"execute in {world} run fill {cx-1} {cy-1} {cz-1} {cx+1} {cy-1} {cz+1} minecraft:bedrock",
        f"execute in {world} run fill {cx-1} {cy} {cz-1} {cx+1} {cy+3} {cz+1} minecraft:air",
        f"execute in {world} run fill {cx-1} {cy} {cz-1} {cx-1} {cy+2} {cz+1} minecraft:bedrock",
        f"execute in {world} run fill {cx+1} {cy} {cz-1} {cx+1} {cy+2} {cz+1} minecraft:bedrock",
        f"execute in {world} run fill {cx-1} {cy} {cz-1} {cx+1} {cy+2} {cz-1} minecraft:bedrock",
        f"execute in {world} run fill {cx-1} {cy} {cz+1} {cx+1} {cy+2} {cz+1} minecraft:bedrock",
    ])
    arena.save_prefab("sealed_cage", (cx - 1, cy - 1, cz - 1, cx + 1, cy + 3, cz + 1))

    rcon.batch([
        f"execute in {world} run fill {pad[0]} {pad[1]} {pad[2]} "
        f"{pad[3]} {pad[4]} {pad[5]} minecraft:air",
    ])
    return ["mining_grid_3x3", "los_wall", "sealed_cage"]
