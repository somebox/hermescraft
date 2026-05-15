"""F45.7: `mc is_empty` and `mc is_filled` region predicates.

Migrated from scripts/test-region-predicates.py. Five scenarios share
a module-level arena fixture and use per-test mutations (empty_region /
fill_region / add_stray / punch_hole) to set up specific states.

Scenarios:
  A: cleared 4×4×4 region → is_empty empty=true.
  B: same with one stray cobble at (2,66,2) → is_empty empty=false,
     non_empty_blocks[0].coord.x=2.
  C: fully filled cobble → is_filled cobble filled=true.
  D: filled with hole at (1,66,1) → is_filled filled=false,
     missing[0].coord = (1,66,1).
  E: region >1000 cells → REGION_TOO_LARGE error.
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def region_arena(rcon, arena, flint_bot, config):
    """Stone-floored area with bot at (0,65,0) facing east. Region predicate
    tests mutate the 4×4×4 box at (0..3, 65..68, 0..3)."""
    world = config["mc"]["world"]
    flint_bot.wait_until_ready(timeout=10)
    rcon.run(f"execute in {world} run tp Flint 0 100 0 0 0")
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.run(f"execute in {world} run tp Flint 0 65 0 90 0")
    arena.settle()
    yield
    rcon.run(f"execute in {world} run tp Flint 0 100 0 0 0")
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")


def _empty(rcon, world: str) -> None:
    rcon.run(f"execute in {world} run fill 0 65 0 3 68 3 minecraft:air")


def _fill_cobble(rcon, world: str) -> None:
    rcon.run(f"execute in {world} run fill 0 65 0 3 68 3 minecraft:cobblestone")


@pytest.mark.functional
def test_is_empty_on_cleared_region(bot, rcon, arena, config, region_arena):
    """A: cleared 4×4×4 region → empty=true."""
    _empty(rcon, config["mc"]["world"])
    arena.settle()
    r = bot.post("/action/is_empty",
                 {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3},
                 timeout=10)
    assert r.get("ok"), r
    assert (r.get("data") or {}).get("empty") is True, r


@pytest.mark.functional
def test_is_empty_reports_non_empty_blocks(bot, rcon, arena, config, region_arena):
    """B: stray cobble at (2,66,2) → empty=false + the stray is in non_empty_blocks."""
    world = config["mc"]["world"]
    _empty(rcon, world)
    rcon.run(f"execute in {world} run setblock 2 66 2 minecraft:cobblestone")
    arena.settle()
    r = bot.post("/action/is_empty",
                 {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3},
                 timeout=10)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("empty") is False, data
    non_empty = data.get("non_empty_blocks") or []
    assert len(non_empty) >= 1, data
    assert non_empty[0].get("name") == "cobblestone", non_empty[0]
    assert non_empty[0].get("coord", {}).get("x") == 2, non_empty[0]


@pytest.mark.functional
def test_is_filled_on_full_region(bot, rcon, arena, config, region_arena):
    """C: filled cobble region → filled=true."""
    _fill_cobble(rcon, config["mc"]["world"])
    arena.settle()
    r = bot.post("/action/is_filled",
                 {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3,
                  "material": "cobblestone"},
                 timeout=10)
    assert r.get("ok"), r
    assert (r.get("data") or {}).get("filled") is True, r


@pytest.mark.functional
def test_is_filled_reports_missing_cells(bot, rcon, arena, config, region_arena):
    """D: filled with hole at (1,66,1) → filled=false + missing[0] = (1,66,1)."""
    world = config["mc"]["world"]
    _fill_cobble(rcon, world)
    rcon.run(f"execute in {world} run setblock 1 66 1 minecraft:air")
    arena.settle()
    r = bot.post("/action/is_filled",
                 {"x1": 0, "y1": 65, "z1": 0, "x2": 3, "y2": 68, "z2": 3,
                  "material": "cobblestone"},
                 timeout=10)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("filled") is False, data
    missing = data.get("missing") or []
    assert len(missing) >= 1, data
    coord = missing[0].get("coord") or {}
    assert (coord.get("x"), coord.get("y"), coord.get("z")) == (1, 66, 1), coord


@pytest.mark.functional
def test_region_too_large_is_rejected(bot, region_arena):
    """E: region >1000 cells → REGION_TOO_LARGE."""
    r = bot.post("/action/is_empty",
                 {"x1": 0, "y1": 65, "z1": 0, "x2": 11, "y2": 75, "z2": 11},
                 timeout=10)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "REGION_TOO_LARGE", r
