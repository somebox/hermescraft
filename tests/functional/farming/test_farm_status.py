"""farm_status: per-cell plot categorization (harvestable / planted /
tilled / empty_soil / etc) + next-action hint.

Paint a 5x5 plot with a known mix of cells, run mc farm_status, assert
each category count matches the painted state, assert the hint points
at harvest (since the test plot contains mature crops).
"""

from __future__ import annotations

import time

import pytest


@pytest.fixture
def status_arena(rcon, config):
    """5x5 plot at y=64 with a stone base. Each test paints its own cells."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        # Default plot surface: grass (will be overwritten per cell below).
        f"execute in {world} run fill -2 64 -2 2 64 2 minecraft:grass_block",
        "clear Tester",
        f"effect clear Tester",
        "gamemode survival Tester",
        # Park bot OUTSIDE the plot so it doesn't occupy any cell being measured.
        f"execute in {world} run tp Tester 4 65 4 0 0",
    ])
    time.sleep(1.5)
    yield
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])


@pytest.mark.functional
def test_farm_status_mixed_plot_counts_correct(bot, rcon, config, status_arena):
    """Plot: 25 cells (5x5). Paint:
      4 mature wheat (age=7 on farmland)
      3 growing wheat (age=2 on farmland)
      5 farmland (tilled, empty)
      6 grass_block (empty_soil)
      4 dirt (empty_soil)
      3 stone (unplantable)
    Total: 25. Plus 1 oak_log on a farmland cell → farmland_occupied.
    Re-counting: 4 + 3 + 5 + 6 + 4 + 3 = 25 (no overlap with the oak_log; let me
    reduce mature to 3 to make room).
    Final: 3 harvestable, 3 growing, 5 tilled, 6 empty (grass), 4 empty (dirt),
           3 unplantable (stone), 1 farmland_occupied (oak_log on farmland).
    Sum: 25. ✓
    """
    world = config["mc"]["world"]
    # Layout: a 5x5 grid at (x=-2..2, z=-2..2). We address cells by index.
    # Row z=-2: 3 mature wheat
    # Row z=-1: 3 growing wheat (only 3 cells, leave 2 as tilled)
    # Row z= 0: 5 tilled (farmland)
    # Row z= 1: 5 empty grass
    # Row z= 2: 4 dirt + 1 stone (4 dirt, but spec said 3 stone — adjust)
    # Adjustment: simpler layout below to hit exact counts.
    # Use direct setblock for the 25 cells:

    cmds = []
    # Reset row blocks to baseline before painting.
    # Row z=-2: 3 mature wheat (cells x=-2,-1,0), 2 tilled (x=1,2)
    for x in [-2, -1, 0]:
        cmds.append(f"execute in {world} run setblock {x} 64 -2 minecraft:farmland")
        cmds.append(f"execute in {world} run setblock {x} 65 -2 minecraft:wheat[age=7]")
    for x in [1, 2]:
        cmds.append(f"execute in {world} run setblock {x} 64 -2 minecraft:farmland")
    # Row z=-1: 3 growing wheat (x=-2,-1,0), 1 farmland_occupied (x=1, oak_log on top), 1 tilled (x=2)
    for x in [-2, -1, 0]:
        cmds.append(f"execute in {world} run setblock {x} 64 -1 minecraft:farmland")
        cmds.append(f"execute in {world} run setblock {x} 65 -1 minecraft:wheat[age=2]")
    cmds.append(f"execute in {world} run setblock 1 64 -1 minecraft:farmland")
    cmds.append(f"execute in {world} run setblock 1 65 -1 minecraft:oak_log")
    cmds.append(f"execute in {world} run setblock 2 64 -1 minecraft:farmland")
    # Row z=0: 5 tilled
    for x in range(-2, 3):
        cmds.append(f"execute in {world} run setblock {x} 64 0 minecraft:farmland")
    # Row z=1: 5 grass_block (empty_soil)
    for x in range(-2, 3):
        cmds.append(f"execute in {world} run setblock {x} 64 1 minecraft:grass_block")
    # Row z=2: 3 dirt + 2 stone
    for x in [-2, -1, 0]:
        cmds.append(f"execute in {world} run setblock {x} 64 2 minecraft:dirt")
    for x in [1, 2]:
        cmds.append(f"execute in {world} run setblock {x} 64 2 minecraft:stone")
    rcon.batch(cmds)
    time.sleep(2.0)

    r = bot.post("/action/farm_status", {
        "x1": -2, "z1": -2, "x2": 2, "z2": 2, "y": 64,
    }, timeout=15)
    assert r.get("ok"), r
    counts = r.get("data", {}).get("counts", {})

    assert counts.get("harvestable") == 3, f"want 3 harvestable, got {counts}"
    assert counts.get("planted_growing") == 3, f"want 3 planted_growing, got {counts}"
    # Tilled cells: 2 (row -2 x=1,2) + 1 (row -1 x=2) + 5 (row 0) = 8
    assert counts.get("tilled") == 8, f"want 8 tilled, got {counts}"
    # empty_soil: 5 grass (row 1) + 3 dirt (row 2) = 8
    assert counts.get("empty_soil") == 8, f"want 8 empty_soil, got {counts}"
    # unplantable: 2 stone (row 2 x=1,2)
    assert counts.get("unplantable") == 2, f"want 2 unplantable, got {counts}"
    # The "oak_log on farmland" cell actually reverts the farmland to dirt
    # under vanilla rules (solid block placed above farmland triggers
    # revert-to-dirt). So the cell categorizes as soil_occupied, not
    # farmland_occupied. This is realistic — farmland_occupied is rare
    # in practice (only non-solid blocks like torches don't trigger revert).
    assert counts.get("soil_occupied") == 1, f"want 1 soil_occupied, got {counts}"
    assert counts.get("farmland_occupied") == 0, f"farmland reverts to dirt when oak_log placed above; want 0, got {counts}"

    # Total column count = 5x5 = 25
    assert r["data"]["column_count"] == 25

    # Harvestable coords sample should include 3 entries (we have exactly 3).
    hv = r["data"]["harvestable_coords"]
    assert len(hv) == 3, hv
    assert all(c["crop"] == "wheat" for c in hv), hv

    # Next-action hint: harvestable > 0 → should suggest mc harvest.
    hint = r.get("next_action_hint", "")
    assert "harvest" in hint.lower(), f"expected harvest hint, got {hint}"


@pytest.mark.functional
def test_farm_status_empty_plot_hints_at_till(bot, rcon, config, status_arena):
    """All-grass plot: hint should suggest mc till_area."""
    # status_arena leaves the 5x5 plot as all grass_block. No further painting.
    r = bot.post("/action/farm_status", {
        "x1": -2, "z1": -2, "x2": 2, "z2": 2, "y": 64,
    }, timeout=15)
    assert r.get("ok"), r
    counts = r["data"]["counts"]
    assert counts.get("empty_soil") == 25, f"want 25 empty_soil, got {counts}"
    assert counts.get("harvestable", 0) == 0
    hint = r.get("next_action_hint", "")
    assert "till" in hint.lower(), f"expected till hint, got {hint}"
