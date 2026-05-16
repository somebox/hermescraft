"""F45.3 / F62: `mc place` raycasts line-of-sight before placing.

Migrated from scripts/test-place-los.py. Closes the "place through wall"
exploit — parallel to the F42 fix for attack-through-wall.

Two scenarios share an arena fixture and differ only in whether a 3×3
cobble wall sits between bot and target cell:
  A: wall present → NO_LINE_OF_SIGHT, target cell stays air.
  B: clear view → placement succeeds (or fails for a non-LOS reason).
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def place_arena(rcon, arena, tester_bot, config):
    """Stone floor at y=64, Tester at (0,65,0) facing east (+x). Inventory
    holds 64 cobblestone — placement is the side effect under test."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.batch([
        f"execute in {world} run tp Tester 0 65 0 90 0",
        "clear Tester",
        "give Tester minecraft:cobblestone 64",
    ])
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")


@pytest.mark.functional
def test_place_refused_when_target_behind_wall(bot, rcon, arena, config, place_arena):
    """A: 3×3 cobble wall at x=2 blocks LOS to target cell (4,65,0).
    Expect NO_LINE_OF_SIGHT and the target cell remains air."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run fill 2 65 -1 2 66 1 minecraft:cobblestone")
    arena.settle()
    r = bot.post("/action/place", {"block": "cobblestone", "x": 4, "y": 65, "z": 0}, timeout=12)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_LINE_OF_SIGHT", r
    # Side-effect check: target cell must still be air.
    assert rcon.block_is(4, 65, 0, "air"), "block was placed despite NO_LINE_OF_SIGHT"


@pytest.mark.functional
def test_place_not_refused_when_target_in_clear_view(bot, rcon, arena, place_arena):
    """B: same target with no wall. Place may succeed OR fail for an
    unrelated reason (reach distance, navigation, etc.) — but it must NOT
    return NO_LINE_OF_SIGHT. That's the F45.3 invariant.
    """
    r = bot.post("/action/place", {"block": "cobblestone", "x": 4, "y": 65, "z": 0}, timeout=12)
    if r.get("ok"):
        assert rcon.block_is(4, 65, 0, "cobblestone"), "place ok=true but block not present"
        return
    code, _, _ = extract_error(r)
    assert code != "NO_LINE_OF_SIGHT", r
