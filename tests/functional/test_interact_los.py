"""F65: `mc interact` raycasts LOS before activating a block.

Migrated from scripts/test-interact-los.py. `mc interact` calls
mineflayer's activateBlock — opens doors, presses buttons. Previously
accepted any block within 4.5-block reach regardless of whether the
bot could see it. F65 added the raycast guard: if every face of the
target is occluded from the bot's eye, return NO_LINE_OF_SIGHT.

Scenarios:
  A: door at (2,65,0) blocked by obsidian at (1,65,0)/(1,66,0) → refused.
  B: same door in open view → opens successfully and we verify the
     door's open state via rcon.block_is.
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def interact_arena(rcon, arena, tester_bot, config):
    """Flat stone-floored region. Each test places its own door + optional
    wall, then teleports Tester to (0,65,0) facing east."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.run(f"clear Tester")
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")


@pytest.mark.functional
def test_interact_refused_when_door_behind_wall(bot, rcon, arena, config, interact_arena):
    """A: door at (2,65,0) blocked by obsidian wall at (1,65,0)/(1,66,0)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:oak_door[half=lower]",
        f"execute in {world} run setblock 2 66 0 minecraft:oak_door[half=upper]",
        f"execute in {world} run setblock 1 65 0 minecraft:obsidian",
        f"execute in {world} run setblock 1 66 0 minecraft:obsidian",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    r = bot.post("/action/interact", {"x": 2, "y": 65, "z": 0}, timeout=15)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_LINE_OF_SIGHT", r
    # Door state preserved — interaction was refused.
    assert rcon.block_is(2, 65, 0, "oak_door[open=false]"), "door opened despite NO_LINE_OF_SIGHT"


@pytest.mark.functional
def test_interact_succeeds_with_clear_view(bot, rcon, arena, config, interact_arena):
    """B: door at (2,65,0) in open air — interact opens it."""
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
