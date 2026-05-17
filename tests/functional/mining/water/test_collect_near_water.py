"""Four water-adjacency scenarios for `mc collect` — strict no-flood test suite.

Tests the tightened isFlooded guard (mining.js): a candidate is rejected if
ANY of its 6 face-neighbours is water (source or flowing). The strip-sort
drops flooded candidates from the pool entirely rather than trying them
last, so the bot should never mine into water in fair-play mode.

Each scenario:
  1. Builds a geometric arrangement of sand + water on a clean arena.
  2. Calls `mc collect sand N`.
  3. Asserts: water source(s) intact, no flowing_water in dug area, no
     bot damage, and either (a) the expected non-flooded sand mined, or
     (b) refusal (TARGET_IN_WATER) when every candidate is flooded.

Arena placement: x ∈ [30, 70], z ∈ [10, 35] to avoid collision with the
strip-flatten test arena (x ∈ [0, 20]).
"""

from __future__ import annotations

import time

import pytest


def _bot_platform(rcon, world, x, z):
    """One-block stone pedestal at y=64 + air around it for the bot to stand on."""
    return [
        f"execute in {world} run fill {x-1} 60 {z-1} {x+1} 70 {z+1} minecraft:air",
        f"execute in {world} run fill {x-1} 60 {z-1} {x+1} 63 {z+1} minecraft:stone",
    ]


@pytest.fixture
def water_arena(rcon, arena, tester_bot, config):
    """Common setup: clean world + a fresh playing field at y=60..70 spanning
    x ∈ [28, 70], z ∈ [8, 36]. Individual tests build their geometry inside."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    arena.clean()
    rcon.batch([
        f"execute in {world} run fill 28 60 8 70 70 36 minecraft:air",
        f"execute in {world} run fill 28 60 8 70 63 36 minecraft:stone",
        "clear Tester",
        "give Tester minecraft:stone_shovel",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
    ])
    arena.settle(seconds=1.5)
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill 28 60 8 70 70 36 minecraft:air")


# ─────────────────────────────────────────────────────────────────────────
# Scenario 1: 3-sand line, water touching the leftmost cell.
#
#   y=64 plan (looking down):
#     x= 30 31 32 33 34
#     z=12  W  S  S  S
#
#   Expected: bot mines (32,64,12) and (33,64,12) — both have no water in
#   their 6-neighbour set. (31,64,12) has water at (30,64,12) → isFlooded
#   true → refused. Net: 2 sand mined, water source intact.
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.functional
def test_sand_adj_single_water_mines_dry_only(bot, rcon, water_arena, config):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 30 64 12 minecraft:water",
        f"execute in {world} run setblock 31 64 12 minecraft:sand",
        f"execute in {world} run setblock 32 64 12 minecraft:sand",
        f"execute in {world} run setblock 33 64 12 minecraft:sand",
        # Bot platform 4 blocks east at y=64 — clear view down the row
        f"execute in {world} run setblock 36 64 12 minecraft:stone",
        f"execute in {world} run tp Tester 36.5 65 12.5 -90 0",  # facing west toward sand
    ])
    time.sleep(2.0)
    pre_hp = (bot.status_lean().get("health") or 0)
    assert rcon.block_is(30, 64, 12, "water"), "setup: water source missing"

    r = bot.post("/action/collect", {"block": "sand", "count": 3}, timeout=45.0)
    assert r.get("ok") is True, f"expected ok=true (≥1 dry sand exists): {r}"

    sand_gain = bot.inventory().get("sand", 0)
    assert sand_gain >= 2, f"expected ≥2 sand mined (the dry pair), got {sand_gain}"

    # Water source must be intact, and no flow into dug cells.
    assert rcon.block_is(30, 64, 12, "water"), "water source flooded into the dug cells"
    # The water-touching sand (31,64,12) must NOT have been mined.
    assert rcon.block_is(31, 64, 12, "sand"), "bot mined the water-adjacent sand block"
    # No flowing_water in the originally-dry cells.
    for (cx, cy, cz) in [(32, 64, 12), (33, 64, 12)]:
        assert not rcon.block_is(cx, cy, cz, "flowing_water"), (
            f"flowing_water appeared at {cx},{cy},{cz} — water guard failed"
        )

    end_hp = (bot.status_lean().get("health") or 0)
    assert end_hp >= pre_hp - 1, f"bot took damage during mine: pre={pre_hp} post={end_hp}"


# ─────────────────────────────────────────────────────────────────────────
# Scenario 2: 4 sand around a 1-cell water source — every sand cell is
# water-adjacent. Bot must refuse all of them.
#
#   y=64 plan:
#     x= 41 42 43
#     z=21     S
#     z=22  S  W  S
#     z=23     S
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.functional
def test_sand_around_water_refuses_all(bot, rcon, water_arena, config):
    world = config["mc"]["world"]
    sand_cells = [(41, 64, 22), (43, 64, 22), (42, 64, 21), (42, 64, 23)]
    rcon.batch([
        f"execute in {world} run setblock 42 64 22 minecraft:water",
        *[f"execute in {world} run setblock {x} {y} {z} minecraft:sand" for (x, y, z) in sand_cells],
        f"execute in {world} run setblock 38 64 22 minecraft:stone",
        f"execute in {world} run tp Tester 38.5 65 22.5 -90 0",
    ])
    time.sleep(2.0)
    pre_hp = (bot.status_lean().get("health") or 0)

    r = bot.post("/action/collect", {"block": "sand", "count": 4}, timeout=30.0)

    # Outcomes: either refuse with TARGET_IN_WATER, or 0 sand mined.
    sand_gain = bot.inventory().get("sand", 0)
    assert sand_gain == 0, f"expected 0 sand (all flooded), got {sand_gain}; r={r}"
    if r.get("ok"):
        assert r.get("data", {}).get("mined_count") == 0, r

    # All 4 sand cells still sand, water source still water.
    assert rcon.block_is(42, 64, 22, "water")
    for (sx, sy, sz) in sand_cells:
        assert rcon.block_is(sx, sy, sz, "sand"), f"sand at {sx},{sy},{sz} was mined despite water adjacency"

    # No flowing_water anywhere in the scenario footprint.
    for cz in range(20, 25):
        for cx in range(40, 45):
            assert not rcon.block_is(cx, 64, cz, "flowing_water"), (
                f"flowing_water at {cx},64,{cz} — pond leaked"
            )

    end_hp = (bot.status_lean().get("health") or 0)
    assert end_hp >= pre_hp - 1


# ─────────────────────────────────────────────────────────────────────────
# Scenario 3: Sand directly below a water column.
#
#   Side view:
#     y=66  W   (water source 2 above sand)
#     y=65  .   (flowing_water as it falls)
#     y=64  S   (sand — water 1 above, isFlooded triggers on "above" cell)
#
#   Bot must refuse.
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.functional
def test_sand_under_water_column_refuses(bot, rcon, water_arena, config):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 50 66 30 minecraft:water",
        f"execute in {world} run setblock 50 64 30 minecraft:sand",
        f"execute in {world} run setblock 55 64 30 minecraft:stone",
        f"execute in {world} run tp Tester 55.5 65 30.5 -90 0",
    ])
    # Give water time to fall and settle into flowing state.
    time.sleep(3.0)
    pre_hp = (bot.status_lean().get("health") or 0)

    r = bot.post("/action/collect", {"block": "sand", "count": 1}, timeout=30.0)

    sand_gain = bot.inventory().get("sand", 0)
    assert sand_gain == 0, f"bot mined sand directly under water column: gained {sand_gain}; r={r}"
    assert rcon.block_is(50, 64, 30, "sand"), "sand below water column was mined"
    assert rcon.block_is(50, 66, 30, "water"), "water source vanished"

    end_hp = (bot.status_lean().get("health") or 0)
    assert end_hp >= pre_hp - 1


# ─────────────────────────────────────────────────────────────────────────
# Scenario 4: water 2 blocks away with a stone buffer — should mine freely.
#
#   y=64 plan:
#     x= 60 61 62 63
#     z=11  W  X  S  S
#
#   (62,64,11): neighbours (61,64,11)=stone (buffer), no water. SAFE.
#   (63,64,11): no water in neighbours. SAFE.
#   Both should mine; water source untouched.
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.functional
def test_sand_two_away_with_buffer_mines_freely(bot, rcon, water_arena, config):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 60 64 11 minecraft:water",
        f"execute in {world} run setblock 61 64 11 minecraft:stone",   # buffer
        f"execute in {world} run setblock 62 64 11 minecraft:sand",
        f"execute in {world} run setblock 63 64 11 minecraft:sand",
        f"execute in {world} run setblock 66 64 11 minecraft:stone",
        f"execute in {world} run tp Tester 66.5 65 11.5 -90 0",
    ])
    time.sleep(2.0)
    pre_hp = (bot.status_lean().get("health") or 0)

    r = bot.post("/action/collect", {"block": "sand", "count": 2}, timeout=45.0)
    assert r.get("ok") is True, f"collect should succeed with safe buffer: {r}"

    sand_gain = bot.inventory().get("sand", 0)
    assert sand_gain >= 2, f"expected 2 sand mined, got {sand_gain}"

    # Buffer + water intact; no flowing_water in dug area.
    assert rcon.block_is(60, 64, 11, "water"), "water source vanished"
    assert rcon.block_is(61, 64, 11, "stone"), "buffer block was mined"
    assert not rcon.block_is(62, 64, 11, "flowing_water"), "water leaked through buffer"
    assert not rcon.block_is(63, 64, 11, "flowing_water"), "water leaked through buffer"

    end_hp = (bot.status_lean().get("health") or 0)
    assert end_hp >= pre_hp - 1
