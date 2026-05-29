"""Two-leg stair-down with a 90° turn between legs.

Arena: canonical ground in the mining zone (east half). Stairs dig down
through dirt and stone substrate — no floating cube.
"""

from __future__ import annotations

import time

import pytest

from tests._lib.functional_fixtures import ARENA_FEET_Y, MINING_CENTER
from tests._lib.mining_stairs_timeouts import (
    goto_surface_timeout,
    retrace_timeout,
    stair_down_timeout,
    wait_bot_settled,
)

CUBE_CENTER = MINING_CENTER
CUBE_HALF = 8
CUBE_X_MIN, CUBE_X_MAX = CUBE_CENTER[0] - CUBE_HALF, CUBE_CENTER[0] + CUBE_HALF
CUBE_Z_MIN, CUBE_Z_MAX = CUBE_CENTER[2] - CUBE_HALF, CUBE_CENTER[2] + CUBE_HALF
PLATFORM_Y = ARENA_FEET_Y


@pytest.fixture
def stair_cube(rcon, arena, bot, config, functional_world):
    rcon.batch(["give Tester minecraft:stone_pickaxe"])
    arena.place_player(
        bot,
        float(CUBE_CENTER[0]),
        float(ARENA_FEET_Y),
        float(CUBE_CENTER[2]),
        expected_floor_y=ARENA_FEET_Y - 1,
        expected_floor_block="grass_block",
    )
    arena.settle_default()
    yield


@pytest.mark.slow
@pytest.mark.functional
def test_stair_south_then_east_with_traversal(bot, rcon, arena, stair_cube, config):
    """Stair south 5, turn, stair east 5, then traverse the L back up."""
    world = config["mc"]["world"]
    start_x = CUBE_X_MIN + 2.5
    start_z = CUBE_Z_MIN + 0.5
    rcon.batch([
        "gamemode survival Tester",
        f"execute in {world} run tp Tester {start_x} {PLATFORM_Y} {start_z} 0 0",
        "effect give Tester minecraft:instant_health 1 5",
    ])
    time.sleep(1.5)

    arena.verify_tester_ready(
        bot,
        expected_xz=(start_x, start_z),
        expected_y_at_least=PLATFORM_Y - 1.0,
        min_hp=19.5,
        xz_tol=1.5,
    )

    leg = 5
    r1 = bot.post(
        "/action/stair_down",
        {"direction": "south", "length": leg},
        timeout=stair_down_timeout(leg),
    )
    assert r1.get("ok") is True, f"leg 1 (south 5) failed: {r1}"
    wait_bot_settled(arena, bot, timeout_s=20.0)
    after_leg1 = bot.status_lean().get("position") or {}
    assert after_leg1.get("y", 0) <= PLATFORM_Y - 4, (
        f"leg 1 didn't descend enough: post.y={after_leg1.get('y')}"
    )
    turn_corner = (after_leg1.get("x"), after_leg1.get("y"), after_leg1.get("z"))

    r2 = bot.post(
        "/action/stair_down",
        {"direction": "east", "length": leg},
        timeout=stair_down_timeout(leg),
    )
    assert r2.get("ok") is True, f"leg 2 (east 5) failed: {r2}"
    wait_bot_settled(arena, bot, timeout_s=20.0)
    after_leg2 = bot.status_lean().get("position") or {}
    assert after_leg2.get("y", 0) <= turn_corner[1] - 4, (
        f"leg 2 didn't descend enough: post.y={after_leg2.get('y')}"
    )
    bottom = dict(after_leg2)

    r_retrace = bot.post(
        "/action/retrace",
        {},
        timeout=retrace_timeout(leg + 2),
    )
    assert r_retrace.get("ok"), f"retrace up east leg failed: {r_retrace}"
    wait_bot_settled(arena, bot, timeout_s=30.0)
    mid = bot.status_lean().get("position") or {}
    corner_dist = (
        abs(mid.get("x", 0) - turn_corner[0])
        + abs(mid.get("z", 0) - turn_corner[2])
    )
    # Retrace only records the east leg; expect near the turn, not exact corner floats.
    assert corner_dist < 5.0 and mid.get("y", 0) >= turn_corner[1] - 2, (
        f"retrace did not reach turn corner: mid={mid}, target={turn_corner}"
    )

    r_top = bot.post(
        "/action/goto",
        {"x": start_x, "y": PLATFORM_Y, "z": start_z},
        timeout=goto_surface_timeout(),
    )
    wait_bot_settled(arena, bot, timeout_s=25.0)
    final = bot.status_lean().get("position") or {}
    top_dist = abs(final.get("x", 0) - start_x) + abs(final.get("z", 0) - start_z)
    assert r_top.get("ok"), f"goto to top failed: {r_top}"
    assert top_dist < 3.0 and final.get("y", 0) >= PLATFORM_Y - 1, (
        f"bot could not reach top of L-staircase: final={final}, target=({start_x},{PLATFORM_Y},{start_z})"
    )

    end = bot.status_lean()
    assert (end.get("health") or 0) >= 18, f"bot took damage on round-trip: HP={end.get('health')}"
