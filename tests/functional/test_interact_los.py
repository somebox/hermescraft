"""F65: interact through obsidian wall — stance-and-act opens door."""

from __future__ import annotations

import pytest

from tests._lib.functional_fixtures import place_obsidian_los_wall, tp_tester_at_origin_facing_west


@pytest.fixture
def interact_arena(functional_world, rcon, arena, tester_bot, config):
    world = config["mc"]["world"]
    rcon.run("clear Tester")
    arena.settle()
    yield


@pytest.mark.functional
@pytest.mark.functional_core
def test_interact_succeeds_when_door_behind_wall(bot, rcon, arena, config, interact_arena):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:oak_door[half=lower]",
        f"execute in {world} run setblock 2 66 0 minecraft:oak_door[half=upper]",
    ])
    place_obsidian_los_wall(rcon, world)
    tp_tester_at_origin_facing_west(rcon, world)
    arena.settle()
    r = bot.post("/action/interact", {"x": 2, "y": 65, "z": 0}, timeout=30)
    assert r.get("ok"), r
    assert rcon.block_is(2, 65, 0, "oak_door[open=true]"), "door should open after stance-and-act"


@pytest.mark.functional
def test_interact_succeeds_with_clear_view(bot, rcon, arena, config, interact_arena):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:oak_door[half=lower]",
        f"execute in {world} run setblock 2 66 0 minecraft:oak_door[half=upper]",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    r = bot.post("/action/interact", {"x": 2, "y": 65, "z": 0}, timeout=15)
    assert r.get("ok"), r
    assert rcon.block_is(2, 65, 0, "oak_door[open=true]"), "interact ok=true but door still closed"
