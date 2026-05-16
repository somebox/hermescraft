"""F55.7: `mc is_sheltered walls=...` runs explicit perimeter sweep.

Migrated from scripts/test-is-sheltered-wall-check.py. Before F55.7,
is_sheltered relied on pathfinder enclosure-search heuristics that
could miss small gaps. F55.7 adds an explicit perimeter sweep that
returns WALLS_INCOMPLETE with the specific missing cells when any
perimeter block is air.

Scenarios:
  A: complete 3×3×3 cobble enclosure → walls check does NOT return
     WALLS_INCOMPLETE (it may still fail for other reasons, e.g. the
     pathfinder finds the exit — F55.7 just owns the walls slice).
  B: same enclosure with one head-level wall block missing →
     WALLS_INCOMPLETE with the gap cell in missing_cells.
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


def _build_enclosure(rcon, world: str, missing_cell: tuple[int, int, int] | None = None) -> None:
    """3×3×3 cobble enclosure floor y=65, walls y=66..67, roof y=68 — minus
    the optional `missing_cell` (x,y,z) to simulate a gap."""
    rcon.run(f"execute in {world} run fill 0 65 0 2 65 2 minecraft:cobblestone")
    for y in (66, 67):
        for (x, z) in [(0, 0), (1, 0), (2, 0),
                       (0, 1),         (2, 1),
                       (0, 2), (1, 2), (2, 2)]:
            if missing_cell == (x, y, z):
                continue
            rcon.run(f"execute in {world} run setblock {x} {y} {z} minecraft:cobblestone")
    rcon.run(f"execute in {world} run fill 0 68 0 2 68 2 minecraft:cobblestone")
    rcon.run(f"execute in {world} run tp Tester 1 66 1 90 0")
    time.sleep(1.0)


@pytest.fixture
def shelter_arena(rcon, arena, tester_bot, config):
    """Stone floor; each test builds its own enclosure with or without a gap."""
    tester_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")


@pytest.mark.functional
def test_complete_enclosure_walls_pass(bot, rcon, config, shelter_arena):
    """A: complete enclosure — code must NOT be WALLS_INCOMPLETE.
    (The is_sheltered call may still fail on the pathfinder enclosure
    check for other reasons; the F55.7 contract is specifically that
    the walls slice doesn't lie about gaps when there are none.)"""
    _build_enclosure(rcon, config["mc"]["world"], missing_cell=None)
    r = bot.post("/action/is_sheltered", {
        "radius": 12,
        "walls": {"x1": 0, "y1": 66, "z1": 0, "x2": 2, "y2": 67, "z2": 2},
    }, timeout=30)
    code, _, _ = extract_error(r)
    assert code != "WALLS_INCOMPLETE", r


@pytest.mark.functional
def test_missing_wall_cell_returns_walls_incomplete(bot, rcon, config, shelter_arena):
    """B: one head-level wall block missing → WALLS_INCOMPLETE with that
    cell listed in missing_cells."""
    _build_enclosure(rcon, config["mc"]["world"], missing_cell=(0, 67, 1))
    r = bot.post("/action/is_sheltered", {
        "radius": 12,
        "walls": {"x1": 0, "y1": 66, "z1": 0, "x2": 2, "y2": 67, "z2": 2},
    }, timeout=30)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "WALLS_INCOMPLETE", r
    missing = obs.get("missing_cells") or []
    assert any(m.get("x") == 0 and m.get("y") == 67 and m.get("z") == 1 for m in missing), obs
