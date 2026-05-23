"""F67: `mc dig` must refuse through-walls mining (line-of-sight guard).

Migrated from scripts/test-dig-los.py. Two scenarios:
  A: target diorite at (2,65,0) behind an obsidian wall at (1,65,0) →
     dig refused with NO_LINE_OF_SIGHT.
  B: same target with the wall removed → dig succeeds and the block is air.

Both share the flat-arena+stone-floor preamble, but each owns its
obstacle setup. No shared fixture — scenarios are independent.
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def los_arena(rcon, arena, tester_bot, config):
    """Air-fill a small region around origin, stone-floor at y=64, give Tester
    a stone_pickaxe, park at (0,65,0) facing east. Each test then places
    its own diorite/obsidian arrangement before exercising dig."""
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"clear Tester",
        f"execute in {world} run give Tester minecraft:stone_pickaxe 1",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    yield
    arena.forceload_remove_all()


@pytest.mark.functional
def test_dig_refused_when_target_behind_wall(bot, rcon, arena, config, los_arena):
    """A: diorite at (2,65,0) blocked by obsidian at (1,65,0) — F67 refuses."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 2 65 0 minecraft:diorite",
        f"execute in {world} run setblock 1 65 0 minecraft:obsidian",
        f"execute in {world} run setblock 1 66 0 minecraft:obsidian",
    ])
    arena.settle()  # let bot perception catch up to the block placements
    r = bot.post("/action/dig", {"x": 2, "y": 65, "z": 0}, timeout=30)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_LINE_OF_SIGHT", r
    # Target diorite still in place — dig was refused, not silently dropped.
    assert rcon.block_is(2, 65, 0, "diorite"), "diorite was removed despite NO_LINE_OF_SIGHT"


@pytest.mark.functional
def test_dig_succeeds_when_target_in_clear_view(bot, rcon, arena, config, los_arena):
    """B: diorite at (2,65,0) with no obstruction — dig succeeds, target is air."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run setblock 2 65 0 minecraft:diorite")
    arena.settle()
    r = bot.post("/action/dig", {"x": 2, "y": 65, "z": 0}, timeout=30)
    assert r.get("ok"), r
    assert rcon.block_is(2, 65, 0, "air"), "dig returned ok but target is not air"
