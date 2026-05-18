"""F71: `mc goto_near` must land at an LOS-valid cell when the target is solid.

Migrated from scripts/test-goto-near-los.py. Setup mirrors the M3 M1
failure: bot enters maze at south, target andesite is at (-2, 65, 2),
and a cobble wall at (-2, 65, 1) sits between south-side landing cells
(blocked from LOS) and north-side landing cells (clear). Without F71,
GoalNear lands at the southern (blocked) side and the follow-up dig
trips F67 NO_LINE_OF_SIGHT.

Only the F71-ON scenario is asserted. The legacy script also probed
`los=false` to "confirm regression," but flagged the result as info-only
(no assertion) — that diagnostic is dropped during migration.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def maze_target(rcon, arena, tester_bot, config):
    """Build the M3 M1 maze fragment: andesite at (-2,65,2) with cobble
    wall at (-2,65,1)/(-2,66,1) blocking south-side LOS. Bot starts at
    (-2,65,-2) facing north."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
    ])
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="grass_block")
    rcon.batch([
        f"execute in {world} run setblock -2 65 2 minecraft:andesite",
        f"execute in {world} run setblock -2 65 1 minecraft:cobblestone",
        f"execute in {world} run setblock -2 66 1 minecraft:cobblestone",
        "clear Tester",
        f"execute in {world} run give Tester minecraft:stone_pickaxe 1",
        f"execute in {world} run effect give Tester minecraft:instant_health 1 5",
        f"execute in {world} run tp Tester -2 65 -2 0 0",
    ])
    arena.settle(seconds=2.5)
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="grass_block")
    arena.forceload_remove_all()


@pytest.mark.functional
def test_goto_near_lands_on_los_valid_side_so_dig_succeeds(bot, rcon, maze_target):
    """F71 default-ON: goto_near picks the north-side cell (LOS to target)
    so the follow-up dig at (-2,65,2) succeeds without NO_LINE_OF_SIGHT.

    The proof is the end-to-end: if F71 picks a bad landing, dig will
    fail. We don't assert on the exact landing coord — multiple cells
    are LOS-valid (e.g. (-1,65,2) and (-3,65,2)) and which one F71 picks
    is a pathfinder choice that may evolve.
    """
    nav = bot.post("/action/goto_near", {"x": -2, "y": 65, "z": 2, "range": 3}, timeout=30)
    assert nav.get("ok"), nav
    dig = bot.post("/action/dig", {"x": -2, "y": 65, "z": 2}, timeout=30)
    assert dig.get("ok"), dig
    assert rcon.block_is(-2, 65, 2, "air"), "dig ok=true but andesite still present"
