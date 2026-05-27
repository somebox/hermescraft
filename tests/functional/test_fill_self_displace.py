"""F60: `place_fill` auto-displaces the bot before placing when it's in-region.

Migrated from scripts/test-fill-self-displace.py. F55.2 detected the
problem post-hoc; F60 prevents it by moving the bot to a safe cell
outside the fill region BEFORE iterating, so all cells place cleanly.

Scenarios:
  A: bot in center of 3×3 fill region top → auto-displace, all 9 placed,
     no bot_was_inside_region flag. Asserts `auto_displaced` truthy.
  B: bot far outside region → per-cell pathfind may drag it in, but
     mid-loop displace recovers; clean fill regardless.
  C: bot in middle of larger 5×1×3 region → displace + complete, AND
     bot's final foot cell is air (safety check from inventory flag —
     a regression where the bot ends up stuck inside placed cobble
     would slip through if we only checked the bot_was_inside flag).

Each scenario asserts a DISTINCT contract — A: auto_displaced flag fires;
B: clean fill when bot was never in-region; C: post-fill end-cell safety.
All three use symmetric rectangles pre-cleared to air. Irregular hole
filling + the `overwrite=true` path are covered separately in
`tests/functional/terrain/test_terrain_shaping.py::test_fill_overwrite_scattered_holes`
— don't duplicate that pattern here.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def fill_arena(rcon, arena, tester_bot, config):
    """Stone floor at y=64, 64 cobble in inventory, peaceful mode."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.batch([
        "clear Tester",
        "give Tester minecraft:cobblestone 64",
    ])
    arena.settle()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")


@pytest.mark.functional
def test_bot_inside_region_auto_displaces(bot, rcon, arena, config, fill_arena):
    """A: bot at (1,66,1), region 0..2/66/0..2 → auto-displace + 9/9 placed."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill 0 65 0 2 65 2 minecraft:stone",
        f"execute in {world} run tp Tester 1 66 1 90 0",
    ])
    arena.settle_water()
    r = bot.post("/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 66, "z1": 0,
        "x2": 2, "y2": 66, "z2": 2,
    }, timeout=30)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("placed") == data.get("total"), data
    assert data.get("partial") in (False, None), data
    assert not data.get("bot_was_inside_region"), data
    # auto_displaced is a {from, to} info dict (not a bool) on a real displace —
    # truthy if the framework moved the bot, falsy/missing if no displacement was needed.
    assert data.get("auto_displaced"), data


@pytest.mark.functional
def test_bot_outside_region_completes_clean(bot, rcon, arena, config, fill_arena):
    """B: bot at (5,65,5), region 0..2/65/0..2 → clean fill regardless
    of whether per-cell pathfind dragged the bot inside mid-loop."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 5 65 5 90 0")
    arena.settle_water()
    r = bot.post("/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 65, "z1": 0,
        "x2": 2, "y2": 65, "z2": 2,
    }, timeout=30)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("placed") == data.get("total"), data
    assert not data.get("bot_was_inside_region"), data


@pytest.mark.functional
def test_large_region_bot_inside_ends_in_safe_cell(bot, rcon, arena, config, fill_arena):
    """C: bot inside 5×1×3 region → displace, fill, AND bot's final foot
    cell is air (not stuck inside placed cobble — safety check)."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 2 65 1 90 0")
    arena.settle_water()
    r = bot.post("/action/place_fill", {
        "block": "cobblestone",
        "x1": 0, "y1": 65, "z1": 0,
        "x2": 4, "y2": 65, "z2": 2,
    }, timeout=30)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("placed") == data.get("total"), data
    assert not data.get("bot_was_inside_region"), data
    # Verify the final standing cell isn't a freshly-placed cobble.
    pos = bot.position()
    px, py, pz = int(pos.get("x", 0)), int(pos.get("y", 0)), int(pos.get("z", 0))
    assert rcon.block_is(px, py, pz, "air"), f"bot foot cell ({px},{py},{pz}) not air after fill"
