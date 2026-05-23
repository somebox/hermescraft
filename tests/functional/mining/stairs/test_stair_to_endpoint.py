"""XFAIL: `mc stair_to X Y Z` doesn't exist yet — this test documents
the spec a future primitive should satisfy.
"""

from __future__ import annotations

import time

import pytest

from tests._lib.functional_fixtures import ARENA_FEET_Y, MINING_CENTER

CUBE_CENTER = MINING_CENTER
CUBE_HALF = 8
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


@pytest.mark.functional
@pytest.mark.skip(reason="mc stair_to endpoint primitive not implemented — spec test only")
def test_stair_to_endpoint_with_auto_turn(bot, rcon, arena, stair_cube, config):
    world = config["mc"]["world"]
    start_x = CUBE_CENTER[0] - CUBE_HALF + 2.5
    start_z = CUBE_CENTER[2] - CUBE_HALF + 0.5
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

    end_x = int(start_x) + 5
    end_y = int(PLATFORM_Y) - 6
    end_z = int(start_z) + 5

    r = bot.post("/action/stair_to", {"x": end_x, "y": end_y, "z": end_z}, timeout=120.0)
    assert r.get("ok") is True, f"stair_to failed (or endpoint doesn't exist yet): {r}"

    pos = bot.status_lean().get("position") or {}
    dist = abs(pos.get("x", 0) - end_x) + abs(pos.get("y", 0) - end_y) + abs(pos.get("z", 0) - end_z)
    assert dist <= 2.0, f"bot ended too far from endpoint: pos={pos}, target=({end_x},{end_y},{end_z})"

    data = r.get("data") or {}
    assert isinstance(data.get("turn_points"), list), f"expected data.turn_points list: {data}"
