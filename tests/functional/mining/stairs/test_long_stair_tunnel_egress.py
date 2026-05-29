"""Long mine route: stair down, 90° turn, horizontal tunnel, return to surface.

Egress stack (matches agent workflow):
  1. mc stair_down (leg 1)
  2. mc stair_down (leg 2, overwrites lastDugSteps)
  3. mc tunnel (flat corridor; nav crumbs sampled)
  4. mc retrace (walks east leg back toward corner)
  5. mc goto (corner → mine entrance on grass)
"""

from __future__ import annotations

import time

import pytest

from tests._lib.functional_fixtures import ARENA_FEET_Y, MINING_CENTER
from tests._lib.mining_stairs_timeouts import (
    goto_surface_timeout,
    retrace_timeout,
    stair_down_timeout,
    tunnel_timeout,
    wait_bot_settled,
)

CUBE_CENTER = MINING_CENTER
CUBE_HALF = 8
CUBE_X_MIN = CUBE_CENTER[0] - CUBE_HALF
CUBE_Z_MIN = CUBE_CENTER[2] - CUBE_HALF
PLATFORM_Y = ARENA_FEET_Y

STAIR_LEN = 8
TUNNEL_LEN = 18
TUNNEL_WIDTH = 2


@pytest.fixture
def mining_egress_arena(rcon, arena, bot, config, functional_world):
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
def test_stair_turn_long_tunnel_return_to_surface(
    bot, rcon, arena, mining_egress_arena, config,
):
    world = config["mc"]["world"]
    start_x = CUBE_X_MIN + 2.5
    start_z = CUBE_Z_MIN + 0.5
    entrance = (start_x, PLATFORM_Y, start_z)

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

    r_south = bot.post(
        "/action/stair_down",
        {"direction": "south", "length": STAIR_LEN},
        timeout=stair_down_timeout(STAIR_LEN),
    )
    assert r_south.get("ok"), f"south stair_down failed: {r_south}"
    wait_bot_settled(arena, bot, timeout_s=25.0)
    after_south = bot.status_lean().get("position") or {}
    turn_corner = (
        after_south.get("x"),
        after_south.get("y"),
        after_south.get("z"),
    )

    r_east = bot.post(
        "/action/stair_down",
        {"direction": "east", "length": STAIR_LEN},
        timeout=stair_down_timeout(STAIR_LEN),
    )
    assert r_east.get("ok"), f"east stair_down failed: {r_east}"
    wait_bot_settled(arena, bot, timeout_s=25.0)
    after_east = bot.status_lean().get("position") or {}
    assert after_east.get("y", 0) <= turn_corner[1] - 6, (
        f"east leg did not descend: y={after_east.get('y')} corner_y={turn_corner[1]}"
    )
    tunnel_y = int(after_east.get("y", PLATFORM_Y))

    r_tunnel = bot.post(
        "/action/tunnel",
        {
            "direction": "east",
            "length": TUNNEL_LEN,
            "width": TUNNEL_WIDTH,
            "height": 3,
            "y": tunnel_y,
            "pickup": False,
        },
        timeout=tunnel_timeout(TUNNEL_LEN, TUNNEL_WIDTH),
    )
    assert r_tunnel.get("ok"), f"tunnel failed: {r_tunnel}"
    wait_bot_settled(arena, bot, timeout_s=45.0, after_heavy_dig=True)
    at_tunnel_end = bot.status_lean().get("position") or {}
    feet_block_y = at_tunnel_end.get("block_y")
    if feet_block_y is None:
        feet_block_y = int(at_tunnel_end.get("y", 0))
    assert feet_block_y <= tunnel_y + 2, (
        f"bot left tunnel floor: pos={at_tunnel_end}, tunnel_y={tunnel_y} "
        f"(tunnel result end={r_tunnel.get('end')})"
    )

    r_retrace = bot.post(
        "/action/retrace",
        {},
        timeout=retrace_timeout(STAIR_LEN + 2),
    )
    assert r_retrace.get("ok"), (
        f"retrace up east stair failed: {r_retrace} "
        f"(legs={r_retrace.get('data', {}).get('legs')})"
    )
    wait_bot_settled(arena, bot, timeout_s=50.0)
    at_corner = bot.status_lean().get("position") or {}
    corner_dist = (
        abs(at_corner.get("x", 0) - turn_corner[0])
        + abs(at_corner.get("z", 0) - turn_corner[2])
    )
    assert corner_dist < 6.0 and at_corner.get("y", 0) >= turn_corner[1] - 2.5, (
        f"retrace did not reach turn area: pos={at_corner}, corner={turn_corner}"
    )

    r_top = bot.post(
        "/action/goto",
        {"x": entrance[0], "y": entrance[1], "z": entrance[2]},
        timeout=goto_surface_timeout(),
    )
    wait_bot_settled(arena, bot, timeout_s=35.0)
    at_surface = bot.status_lean().get("position") or {}
    top_dist = abs(at_surface.get("x", 0) - start_x) + abs(at_surface.get("z", 0) - start_z)
    assert r_top.get("ok"), f"goto mine entrance failed: {r_top}"
    assert top_dist < 4.0 and at_surface.get("y", 0) >= PLATFORM_Y - 1.5, (
        f"bot not at surface after egress: pos={at_surface}, entrance={entrance}"
    )
    assert (bot.status_lean().get("health") or 0) >= 18, "took damage on long egress route"
