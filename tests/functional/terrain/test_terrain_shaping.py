"""Terrain-shaping primitives — irregular fill, ground leveling, scattered gather.

These three cases plug coverage gaps identified in the 2026-05-27 audit:
- Existing fill tests only verify symmetric 3×3 / 5×1×3 boxes.
- Existing collect tests only run against deterministic 3×3 pillar grids.
- `mc level_ground` (shipped 2026-05-27) had a planner unit test but no
  end-to-end execution against live mineflayer.

Each test uses `arena.scatter_holes_and_pillars` to synthesize a "messy
field" (Python parallel of the unit-test synthesizer in
`bot/test/actions/level-ground.test.js`). Layouts are seeded so failures
are reproducible.

Tests are kept narrow + non-overlapping with the existing suite:
- Fill tests in test_fill_self_displace cover symmetric placement +
  bot displacement. THIS file covers irregular targets + overwrite.
- Collect tests in test_mine_collect_grid cover the deterministic
  3×3 case + walk-away pickup. THIS file covers scattered targets +
  block-type discrimination.
- No level_ground functional test existed before; this is its first.
"""

from __future__ import annotations

import math
import time

import pytest


# Park the arena near origin to keep coords readable in failure messages.
# y=64 = grass cap, y=65 = bot foot.
GROUND_Y = 64
FEET_Y = 65


@pytest.fixture
def terrain_arena(rcon, arena, config):
    """Clear arena, ensure Tester has fill blocks + a pickaxe + food."""
    arena.settle_default()
    rcon.batch([
        "clear Tester",
        "give Tester minecraft:stone_pickaxe 1",
        "give Tester minecraft:stone_axe 1",
        "give Tester minecraft:cobblestone 64",
        "give Tester minecraft:dirt 64",
        "give Tester minecraft:bread 16",
    ])
    arena.settle_fast()
    yield


@pytest.mark.functional
def test_fill_overwrite_scattered_holes(bot, rcon, arena, config, terrain_arena):
    """mc fill overwrite=true over an irregular hole pattern.

    Validates the T5b fix (2026-05-27): default behavior refuses with
    FILL_BLOCKED_BY_EXISTING when cells are occupied; overwrite=true
    dig-then-fills. This is the first test of either path against a
    truly irregular target (the existing fill tests use rectangles
    pre-cleared to air).
    """
    world = config["mc"]["world"]
    # Tight 4×4 box (= 16 cells, AT the new cap) with 3 holes + 1 pillar.
    bbox = (10, 0, 13, 3)  # x1,z1,x2,z2 — small for fast test
    bbox_h = (10, 0, 13, 3)
    layout = arena.scatter_holes_and_pillars(
        bbox=bbox_h,
        ground_y=GROUND_Y,
        n_holes=3,
        n_pillars=1,
        max_hole_depth=2,
        max_pillar_height=2,
        seed=4242,
    )
    # TP bot to a safe cell outside the work area but in view.
    rcon.run(f"execute in {world} run tp Tester 8 {FEET_Y} 1 90 0")
    arena.settle_water()

    # First: confirm default (overwrite=false) refuses because the pillar
    # cell + the surface grass cells are occupied.
    r = bot.post("/action/place_fill", {
        "block": "cobblestone",
        "x1": 10, "y1": GROUND_Y, "z1": 0,
        "x2": 13, "y2": GROUND_Y, "z2": 3,
    }, timeout=30)
    assert r.get("ok") is False, f"expected FILL_BLOCKED without overwrite, got {r}"
    err = r.get("error") or {}
    assert err.get("code") == "FILL_BLOCKED_BY_EXISTING", err
    # next_action_hint should literally name `overwrite=true` so an agent
    # reading the error knows the recovery path.
    assert "overwrite=true" in (err.get("next_action_hint") or ""), err

    # Now retry with overwrite=true — should dig the surface grass then fill.
    r2 = bot.post("/action/place_fill", {
        "block": "cobblestone",
        "x1": 10, "y1": GROUND_Y, "z1": 0,
        "x2": 13, "y2": GROUND_Y, "z2": 3,
        "overwrite": True,
    }, timeout=60)
    assert r2.get("ok"), r2
    data = r2.get("data") or {}
    # All 16 cells should be cobblestone at GROUND_Y after the call.
    # Allow a small shortfall (1 cell) for occasional placement races.
    placed = data.get("placed") or 0
    assert placed >= 15, f"expected ≥15/16 placed with overwrite; got {data}"
    # Spot-check 3 random cells (corners + center).
    for (cx, cz) in [(10, 0), (13, 3), (11, 2)]:
        assert rcon.block_is(cx, GROUND_Y, cz, "cobblestone"), \
            f"cell ({cx},{GROUND_Y},{cz}) not cobblestone after overwrite fill"


@pytest.mark.functional
def test_level_ground_execute_messy(bot, rcon, arena, config, terrain_arena):
    """mc level_ground execute=true on a messy 4×4 → flat.

    First end-to-end test of the level_ground execution path. The planner
    is already unit-tested in bot/test/actions/level-ground.test.js;
    this confirms the delegation to mc level actually flattens live
    terrain in mineflayer.
    """
    world = config["mc"]["world"]
    layout = arena.scatter_holes_and_pillars(
        bbox=(20, 10, 23, 13),  # 4×4 = 16 cols, at cap
        ground_y=GROUND_Y,
        n_holes=3,
        n_pillars=2,
        max_hole_depth=2,
        max_pillar_height=3,
        seed=7777,
    )
    rcon.run(f"execute in {world} run tp Tester 18 {FEET_Y} 11 90 0")
    arena.settle_water()

    # First a dry-run to confirm the planner sees the anomalies.
    r_plan = bot.post("/action/level_ground", {
        "x1": 20, "z1": 10, "x2": 23, "z2": 13,
    }, timeout=30)
    assert r_plan.get("ok"), r_plan
    plan = r_plan.get("data") or {}
    assert plan.get("summary", {}).get("holes_n") == 3, plan
    assert plan.get("summary", {}).get("pillars_n") == 2, plan
    assert plan.get("target_y") == GROUND_Y, plan

    # Now execute with cobblestone fill.
    r_exec = bot.post("/action/level_ground", {
        "x1": 20, "z1": 10, "x2": 23, "z2": 13,
        "execute": True,
        "block": "cobblestone",
    }, timeout=120)
    assert r_exec.get("ok"), r_exec
    exec_data = r_exec.get("data") or {}
    assert exec_data.get("executed") is True, exec_data

    # Verify every column's top is now GROUND_Y. Allow 1-cell shortfall for race.
    misses = []
    for x in range(20, 24):
        for z in range(10, 14):
            # The TOP non-air block at this column should be at GROUND_Y.
            # We check (x, GROUND_Y+1, z) is air AND (x, GROUND_Y, z) is solid.
            above_air = rcon.block_is(x, GROUND_Y + 1, z, "air")
            top_solid = not rcon.block_is(x, GROUND_Y, z, "air")
            if not (above_air and top_solid):
                misses.append((x, GROUND_Y, z))
    assert len(misses) <= 1, f"level_ground left {len(misses)} non-level columns: {misses[:5]}"


@pytest.mark.functional
def test_collect_scattered_target_with_distractors(bot, rcon, arena, config, terrain_arena):
    """mc collect against scattered iron_ore mixed with coal_ore distractors.

    Existing collect tests use a uniform 3×3 cobblestone grid — every
    visible block is a target. This verifies type-discrimination
    (collect iron, not coal) AND non-grid spatial layout.
    """
    world = config["mc"]["world"]
    # 5×5 stone slab as the test substrate so we can place ore on top.
    rcon.batch([
        f"execute in {world} run fill 30 {GROUND_Y - 1} 20 34 {GROUND_Y} 24 minecraft:stone",
        f"execute in {world} run fill 30 {GROUND_Y + 1} 20 34 {GROUND_Y + 4} 24 minecraft:air",
    ])
    # Scatter 4 iron_ore + 4 coal_ore at hand-picked cells (not a regular grid).
    iron_cells = [(30, 21), (32, 20), (33, 23), (34, 22)]
    coal_cells = [(31, 22), (32, 24), (30, 24), (34, 20)]
    cmds = [f"execute in {world} run setblock {x} {GROUND_Y} {z} minecraft:iron_ore" for (x, z) in iron_cells]
    cmds += [f"execute in {world} run setblock {x} {GROUND_Y} {z} minecraft:coal_ore" for (x, z) in coal_cells]
    rcon.batch(cmds)
    rcon.run(f"execute in {world} run tp Tester 28 {FEET_Y} 22 90 0")
    arena.settle_water()

    # Snapshot inventory pre-collect so we can measure the delta.
    inv_before = bot.inventory()
    raw_iron_before = inv_before.get("raw_iron", 0)
    coal_before = inv_before.get("coal", 0)

    r = bot.post("/action/collect", {"block": "iron_ore", "count": 4}, timeout=120)
    assert r.get("ok"), r
    data = r.get("data") or {}
    mined = data.get("mined_count") or 0
    assert mined >= 3, f"expected ≥3/4 iron_ore mined (some race tolerance); got {data}"

    # Inventory should gain raw_iron but NOT coal — block-type discrimination.
    inv_after = bot.inventory()
    iron_gained = inv_after.get("raw_iron", 0) - raw_iron_before
    coal_gained = inv_after.get("coal", 0) - coal_before
    assert iron_gained >= 2, f"raw_iron delta {iron_gained} below 2; data={data}"
    assert coal_gained == 0, f"coal_ore was a distractor — collect should NOT have mined it; coal_gained={coal_gained}"

    # Verify the coal_ore cells are still in place — collect didn't touch them.
    for (cx, cz) in coal_cells:
        assert rcon.block_is(cx, GROUND_Y, cz, "coal_ore"), \
            f"coal_ore at ({cx},{GROUND_Y},{cz}) was mined despite being a distractor"
