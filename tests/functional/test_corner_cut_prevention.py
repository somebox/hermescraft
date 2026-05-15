"""F63: pathfinder refuses corner-clipping diagonals.

Migrated from scripts/test-corner-cut-prevention.py. Without the fix,
mineflayer-pathfinder's `getMoveDiagonal` allowed a diagonal step when
at least one of the two perpendicular intermediate cells was air —
with the bot's 0.6-wide hitbox, that diagonal scrapes the solid corner
block of the OTHER perpendicular cell. Bot wedges on the corner, ends
up off-grid, stuck-recovery fires repeatedly.

F63 refuses the diagonal when EITHER perpendicular cell at body height
(y, y+1) is physical. Bot routes around via two cardinal steps.

Scenarios:
  A: single 2-tall obsidian pillar between bot and goal — bot routes
     cardinally and reaches goal in <25s.
  B: L-shaped 2-tall wall — bot navigates inside corner without scraping.
"""

from __future__ import annotations

import time

import pytest


@pytest.fixture
def flat_floor(rcon, arena, flint_bot, config):
    """Flat stone floor; each test places its own obstacles + bot start pose."""
    flint_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.run("clear Flint")
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")


@pytest.mark.functional
def test_routes_around_single_pillar(bot, rcon, arena, config, flat_floor):
    """A: pillar at (1,65,1), bot at (-1,65,-1), goal (3,65,3). Bot must
    reach within range=1 in <25s — implies it didn't get stuck on the
    pillar's corner."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 1 65 1 minecraft:obsidian",
        f"execute in {world} run setblock 1 66 1 minecraft:obsidian",
        f"execute in {world} run tp Flint -1 65 -1 90 0",
    ])
    arena.settle()
    t0 = time.time()
    r = bot.post("/action/goto_near", {"x": 3, "y": 65, "z": 3, "range": 1}, timeout=40)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    pos = bot.position()
    assert abs(pos.get("x", 99) - 3) <= 2 and abs(pos.get("z", 99) - 3) <= 2, pos
    assert elapsed < 25.0, f"goto_near took {elapsed:.1f}s — bot likely scraped pillar corner"


@pytest.mark.functional
def test_routes_around_inside_corner_of_l_wall(bot, rcon, arena, config, flat_floor):
    """B: L-shaped 2-tall obsidian wall (south leg z=2 x=0..5, east leg
    x=5 z=2..7). Bot enters at (0,0), exits at (7,5)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill 0 65 2 5 66 2 minecraft:obsidian",
        f"execute in {world} run fill 5 65 2 5 66 7 minecraft:obsidian",
        f"execute in {world} run tp Flint 0 65 0 90 0",
    ])
    arena.settle()
    t0 = time.time()
    r = bot.post("/action/goto_near", {"x": 7, "y": 65, "z": 5, "range": 1}, timeout=40)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    pos = bot.position()
    assert abs(pos.get("x", 99) - 7) <= 2 and abs(pos.get("z", 99) - 5) <= 2, pos
    assert elapsed < 25.0, f"goto_near took {elapsed:.1f}s — bot scraped the inside corner"
