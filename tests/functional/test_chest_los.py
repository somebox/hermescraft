"""F64: `openContainer` raycasts LOS before opening a chest.

Migrated from scripts/test-chest-los.py. The list_container / withdraw /
deposit verbs all call openContainer under the hood. Before F64 they
accepted any chest within reach (4.5 blocks) regardless of whether the
bot could see it — bots opened chests through walls. F64 adds the
raycast guard.

Scenarios:
  A: chest at (2,65,0) blocked by obsidian wall → NO_LINE_OF_SIGHT.
  B: chest in open view → list_container succeeds.
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error
from tests._lib.functional_fixtures import place_obsidian_los_wall, tp_tester_at_origin_facing_east


@pytest.fixture
def chest_arena(rcon, arena, tester_bot, config):
    """Flat stone floor. Each test places its own chest + optional wall."""
    rcon.run("clear Tester")
    arena.settle()
    yield


@pytest.mark.functional
def test_list_container_refused_when_chest_behind_wall(bot, rcon, arena, config, chest_arena):
    """A: chest at (2,65,0) blocked by obsidian wall at (1,65,0)/(1,66,0)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:chest",
    ])
    place_obsidian_los_wall(rcon, world)
    tp_tester_at_origin_facing_east(rcon, world)
    arena.settle()
    r = bot.post("/action/list_container", {"x": 2, "y": 65, "z": 0}, timeout=15)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_LINE_OF_SIGHT", r


@pytest.mark.functional
def test_list_container_succeeds_with_clear_view(bot, rcon, arena, config, chest_arena):
    """B: chest at (2,65,0) in open air — list_container opens it."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:chest",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    r = bot.post("/action/list_container", {"x": 2, "y": 65, "z": 0}, timeout=15)
    assert r.get("ok"), r
