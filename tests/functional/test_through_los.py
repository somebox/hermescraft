"""F68: `mc through` must refuse opening gates behind walls.

Migrated from scripts/test-through-los.py. The `through` verb opens a
fence gate or door, walks the bot to a coord on the other side, and
optionally closes the gate. F68 added the LOS guard so the bot can't
"teleport" interaction through a wall (e.g. opening a gate it cannot
physically see).

Two scenarios share an arena fixture and differ only in whether an
obsidian wall stands between the bot and the gate:
  A: wall blocks LOS → NO_LINE_OF_SIGHT, gate stays closed.
  B: clear view → through succeeds, gate transitions to open.
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def through_arena(rcon, arena, tester_bot, config):
    """Flat stone-floored region, Tester at (0,65,0) facing east. Each
    test then places its own wall/gate configuration."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.forceload((-1, -1, 1, 1))
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.batch([
        "clear Tester",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")
    arena.forceload_remove_all()


@pytest.mark.functional
def test_through_refused_when_gate_behind_wall(bot, rcon, arena, config, through_arena):
    """A: 2-block-thick obsidian wall at x=1..2 blocks LOS to gate at x=3."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill 1 65 -1 2 66 1 minecraft:obsidian",
        f"execute in {world} run setblock 3 65 0 minecraft:oak_fence_gate[facing=east,open=false,in_wall=false]",
    ])
    arena.settle()
    r = bot.post(
        "/action/through",
        {"gx": 3, "gy": 65, "gz": 0, "dx": 5, "dy": 65, "dz": 0},
        timeout=30,
    )
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_LINE_OF_SIGHT", r
    # Gate state preserved — through refused, no side effect.
    assert rcon.block_is(3, 65, 0, "oak_fence_gate[open=false]"), "gate opened despite NO_LINE_OF_SIGHT"


@pytest.mark.functional
def test_through_succeeds_with_clear_view(bot, rcon, arena, config, through_arena):
    """B: gate at (3,65,0) with no obstruction — through opens it and walks past."""
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
    # Bot crossed to the far side of the gate.
    assert bot.position().get("x", -99) >= 4.0, bot.position()
