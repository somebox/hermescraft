"""F68: through gate behind wall — stance-and-act opens gate and crosses."""

from __future__ import annotations

import pytest


@pytest.fixture
def through_arena(functional_world, rcon, arena, tester_bot, config):
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        "clear Tester",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    yield


@pytest.mark.functional
@pytest.mark.functional_core
def test_through_succeeds_when_gate_behind_wall(bot, rcon, arena, config, through_arena):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill 1 65 -1 2 66 1 minecraft:obsidian",
        f"execute in {world} run setblock 3 65 0 minecraft:oak_fence_gate[facing=east,open=false,in_wall=false]",
    ])
    arena.settle()
    r = bot.post(
        "/action/through",
        {"gx": 3, "gy": 65, "gz": 0, "dx": 5, "dy": 65, "dz": 0},
        timeout=45,
    )
    assert r.get("ok"), r
    assert bot.position().get("x", -99) >= 4.0, bot.position()


@pytest.mark.functional
def test_through_succeeds_with_clear_view(bot, rcon, arena, config, through_arena):
    world = config["mc"]["world"]
    rcon.run(
        f"execute in {world} run setblock 3 65 0 minecraft:oak_fence_gate[facing=east,open=false,in_wall=false]"
    )
    arena.settle()
    r = bot.post(
        "/action/through",
        {"gx": 3, "gy": 65, "gz": 0, "dx": 5, "dy": 65, "dz": 0},
        timeout=30,
    )
    assert r.get("ok"), r
    assert bot.position().get("x", -99) >= 4.0, bot.position()
