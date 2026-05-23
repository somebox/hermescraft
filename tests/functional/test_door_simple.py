"""Simplest door scenario: pre-opened door in flat arena; bot walks past it.

Migrated from scripts/test-door-simple.py. Verifies that the pathfinder
treats an open oak_door cell as walkable — the door slab swings open
along an axis perpendicular to the bot's travel, so there's no physical
obstruction. Failure would mean either the navmesh is treating the door
cell as solid or the bot fails to acquire a path to a coord on the
other side of the door.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def open_door_arena(rcon, arena, tester_bot, config):
    """Build a flat 31×31 stone-floored region with a single pre-OPENED oak
    door at (0,65,0) facing east. Bot starts at (-3, 65, 0) facing east.
    Forceload chunks 0,0 (block coords ±16) since the world may have
    unloaded them between runs.
    """
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run setblock 0 65 0 minecraft:oak_door[half=lower,facing=east,open=true,hinge=left]",
        f"execute in {world} run setblock 0 66 0 minecraft:oak_door[half=upper,facing=east,open=true,hinge=left]",
        f"execute in {world} run tp Tester -3 65 0 90 0",
    ])
    arena.settle()
    yield
    arena.forceload_remove_all()


@pytest.mark.functional
def test_bot_walks_past_open_door(bot, rcon, open_door_arena):
    """Open door at (0,65,0), bot at (-3,65,0) — goto_near 3,65,0 succeeds.

    Pre-flight assert: the door really is in `open=true` state. If a
    test-pre-state regression closes it (e.g. a different test left the
    world in an odd state and the setblock above raced), the bot might
    open it via F66 — that's a different test (test-through-los). Here
    we want the trivial "already open" case.
    """
    assert rcon.block_is(0, 65, 0, "oak_door[open=true]"), "door state regressed before test"
    r = bot.post("/action/goto_near", {"x": 3, "y": 65, "z": 0, "range": 1}, timeout=15)
    assert r.get("ok"), r
    pos = bot.position()
    # Bot should have crossed to x ≥ 2 (door at x=0, goal at x=3, range=1).
    assert pos.get("x", -99) >= 2.0, pos
