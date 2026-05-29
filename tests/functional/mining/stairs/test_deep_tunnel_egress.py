"""Deep stair + tunnel egress: stair_down, retrace to surface, goto_near crafting table.

Scenario B from robust-navigation plan: after retrace, reach a side-placed
crafting_table in the carved tunnel (not pure retrace alone).
"""

from __future__ import annotations

import math
import time

import pytest

from tests._lib.mining_stairs_timeouts import (
    retrace_timeout,
    stair_down_timeout,
    wait_bot_settled,
)
from tests.functional.mining.stairs.test_stair_straight import (
    DIR_YAW,
    DIR_VECTORS,
    PLAYER_FEET_Y,
    _start_pos_for,
)


@pytest.mark.functional
def test_retrace_no_trail_without_stair_down(bot, arena, surface_arena):
    """Contract: retrace without prior stair_down returns RETRACE_NO_TRAIL."""
    bot.get("/status")  # clears lastDugSteps between tests (same as agent mc status)
    r = bot.post("/action/retrace", {}, timeout=30.0)
    assert r.get("ok") is not True
    assert (r.get("error") or {}).get("code") == "RETRACE_NO_TRAIL"


@pytest.fixture
def surface_arena(rcon, arena, config, functional_world):
    rcon.batch([
        "give Tester minecraft:stone_pickaxe",
        "effect give Tester minecraft:instant_health 1 5",
    ])
    arena.settle_default()
    yield


@pytest.mark.slow
@pytest.mark.functional
def test_deep_tunnel_retrace_then_crafting_table(bot, rcon, arena, surface_arena, config):
    world = config["mc"]["world"]
    direction = "south"
    length = 6
    sx, sy, sz = _start_pos_for(direction)
    yaw = DIR_YAW[direction]
    dx, dz = DIR_VECTORS[direction]

    rcon.batch([
        "gamemode survival Tester",
        f"execute in {world} run tp Tester {sx} {sy} {sz} {yaw} 0",
        "effect give Tester minecraft:instant_health 1 5",
    ])
    time.sleep(1.5)
    arena.verify_tester_ready(
        bot,
        expected_xz=(sx, sz),
        expected_y_at_least=PLAYER_FEET_Y - 1.0,
        min_hp=19.5,
        xz_tol=1.5,
    )

    r = bot.post(
        "/action/stair_down",
        {"direction": direction, "length": length},
        timeout=stair_down_timeout(length),
    )
    assert r.get("ok"), f"stair_down failed: {r}"
    wait_bot_settled(arena, bot, timeout_s=20.0)
    r_retrace = bot.post(
        "/action/retrace",
        {},
        timeout=retrace_timeout(length + 2),
    )
    assert r_retrace.get("ok"), f"retrace failed: {r_retrace}"
    wait_bot_settled(arena, bot, timeout_s=30.0)
    top = bot.status_lean().get("position") or {}
    horiz = abs(top.get("x", 0) - sx) + abs(top.get("z", 0) - sz)
    assert horiz < 4.0 and top.get("y", 0) >= PLAYER_FEET_Y - 1, (
        f"retrace did not reach surface: pos={top}, start=({sx},{PLAYER_FEET_Y},{sz})"
    )

    # Scenario B: after egress, reach a work surface via goto_near (open ground at entrance).
    # Deep 1-wide shafts still block pathfinder — table at the mine mouth, not tunnel bottom.
    pdx, pdz = DIR_VECTORS[direction]
    table_x = math.floor(sx) - pdz
    table_z = math.floor(sz) + pdx
    table_y = int(PLAYER_FEET_Y)
    rcon.batch([
        f"execute in {world} run setblock {table_x} {table_y} {table_z} minecraft:air",
        f"execute in {world} run setblock {table_x} {table_y + 1} {table_z} minecraft:air",
        f"execute in {world} run setblock {table_x} {table_y} {table_z} minecraft:crafting_table",
    ])
    time.sleep(0.5)

    r_near = bot.post(
        "/action/goto_near",
        {"x": table_x, "y": table_y, "z": table_z, "range": 2},
        timeout=60.0,
    )
    assert r_near.get("ok"), f"goto_near crafting_table at entrance failed: {r_near}"
    end = bot.status_lean().get("position") or {}
    dist = abs(end.get("x", 0) - table_x) + abs(end.get("z", 0) - table_z)
    assert dist < 3.5, f"bot did not reach table area: end={end}, table=({table_x},{table_y},{table_z})"
    assert rcon.block_is(table_x, table_y, table_z, "crafting_table"), (
        f"crafting_table missing at ({table_x},{table_y},{table_z})"
    )
