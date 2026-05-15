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


@pytest.fixture
def chest_arena(rcon, arena, flint_bot, config):
    """Flat stone floor. Each test places its own chest + optional wall."""
    flint_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.run("clear Flint")
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")


@pytest.mark.functional
def test_list_container_refused_when_chest_behind_wall(bot, rcon, arena, config, chest_arena):
    """A: chest at (2,65,0) blocked by obsidian wall at (1,65,0)/(1,66,0)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:chest",
        f"execute in {world} run setblock 1 65 0 minecraft:obsidian",
        f"execute in {world} run setblock 1 66 0 minecraft:obsidian",
        f"execute in {world} run tp Flint 0 65 0 90 0",
    ])
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
        f"execute in {world} run tp Flint 0 65 0 90 0",
    ])
    arena.settle()
    r = bot.post("/action/list_container", {"x": 2, "y": 65, "z": 0}, timeout=15)
    assert r.get("ok"), r
