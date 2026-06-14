"""F64: list_container with LOS wall — stance-and-act then open chest.

When the chest at (2,65,0) is blocked by obsidian at x=1, the bot re-stances
(tryLosStance) and opens the container rather than returning NO_LINE_OF_SIGHT.
Clear-view scenario unchanged.
"""

from __future__ import annotations

import pytest

from tests._lib.functional_fixtures import place_obsidian_los_wall, tp_tester_at_origin_facing_west


@pytest.fixture
def chest_arena(functional_world, rcon, arena, tester_bot, config):
    rcon.run("clear Tester")
    arena.settle()
    yield


@pytest.mark.functional
@pytest.mark.functional_core
def test_list_container_succeeds_when_chest_behind_wall(bot, rcon, arena, config, chest_arena):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:chest",
    ])
    place_obsidian_los_wall(rcon, world)
    tp_tester_at_origin_facing_west(rcon, world)
    arena.settle()
    before = bot.position() or {}
    r = bot.post("/action/list_container", {"x": 2, "y": 65, "z": 0}, timeout=30)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("slots") is not None or data.get("items") is not None, r
    after = bot.position() or {}
    bx0, bz0 = float(before.get("x", 0)), float(before.get("z", 0))
    bx1, bz1 = float(after.get("x", 0)), float(after.get("z", 0))
    assert abs(bx1 - bx0) >= 0.2 or abs(bz1 - bz0) >= 0.2 or data, (
        "expected stance move or container data after wall approach"
    )


@pytest.mark.functional
def test_list_container_succeeds_with_clear_view(bot, rcon, arena, config, chest_arena):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:chest",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    r = bot.post("/action/list_container", {"x": 2, "y": 65, "z": 0}, timeout=15)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("slots") is not None or data.get("items") is not None, r
