"""Primitive-level fair-play mining: mc collect must not 'stab' through walls.

Migrated from scripts/test-mine-behind-wall.py. Without the post-pathfind
LOS check, `mc collect <block>` could mine a target visible from above
(top-face raycasts to eye) but with no mineable face from the bot's
ground position — i.e. dig packet accepted by Paper on reach distance
alone. The LOS check requires a clear ray from bot eye to the
bot-facing face; blocks behind walls are classified `behind_wall` and
skipped.

Scenarios:
  A: clear LOS to stone at (-2,65,0) → mines it, mined_count=1.
  B: 2-thick cobble wall at x=-1,-2 + back-row stone at -4 only visible
     after wall is cleared. With only the hidden stone matching the query,
     collect must not mine through the wall (mined_count=0, -4 stays stone).
  C: bot sealed in a 1×1 shelter, hidden stone at (0,65,0) beyond the
     wall → NO_VISIBLE_BLOCKS, stone intact.
  D: 3×3×3 deposit → one collect call mines ≥6 of 27.
  E: small dry deposit + adjacent pond → bot exhausts the deposit
     without diving for underwater candidates.
"""

from __future__ import annotations

import time

import pytest

from tests._lib.combat_fixtures import hold_reactive


@pytest.fixture
def mine_arena(rcon, arena, tester_bot, config):
    """Wide clean area + packed sub-floor + grass cap. Bot at (3,65,0)
    facing west — gives 4-7m to candidates at x=-1..-4 (within visibility
    scan's FOV)."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run fill -16 65 -16 16 70 16 minecraft:air",
        f"execute in {world} run fill -16 60 -16 16 63 16 minecraft:stone",
        f"execute in {world} run fill -16 64 -16 16 64 16 minecraft:grass_block",
    ])
    arena.settle_default()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.run(f"execute in {world} run fill -16 60 -16 16 80 16 minecraft:air")
    arena.forceload_remove_all()


def _stage_arena_and_bot(rcon, world: str, extra_cmds: list[str]) -> None:
    """Apply extra setup, then re-TP Tester to (3,65,0) facing west, with
    pickaxe + saturation. The 3.5s settle is load-bearing for the bot
    to perceive newly-placed blocks before the test runs collect."""
    cmds = list(extra_cmds)
    cmds += [
        f"execute in {world} run tp Tester 3 65 0 90 0",
        "clear Tester",
        "give Tester minecraft:stone_pickaxe 1",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
    ]
    rcon.batch(cmds)
    time.sleep(3.5)



@pytest.mark.functional
def test_collect_mines_block_in_clear_view(bot, rcon, arena, config, mine_arena):
    """A: clear LOS to (-2,65,0); collect mines it."""
    world = config["mc"]["world"]
    _stage_arena_and_bot(rcon, world, [
        f"execute in {world} run setblock -2 65 0 minecraft:stone",
    ])
    hold_reactive(bot)
    r = bot.post("/action/collect", {"block": "stone", "count": 1, "range": 10}, timeout=60)
    data = r.get("data") or {}
    assert data.get("mined_count") == 1, r
    assert rcon.block_is(-2, 65, 0, "air"), "stone still present after collect"


@pytest.mark.functional
def test_collect_does_not_mine_stone_hidden_behind_wall(bot, rcon, arena, config, mine_arena):
    """B: cobble occluders at x=-1,-2; only target is stone at x=-4 behind them.
    collect stone count=1 must refuse (no stab-through); hidden block stays."""
    world = config["mc"]["world"]
    _stage_arena_and_bot(rcon, world, [
        f"execute in {world} run setblock -1 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock -2 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock -4 65 0 minecraft:stone",
    ])
    hold_reactive(bot)
    r = bot.post("/action/collect", {"block": "stone", "count": 1, "range": 10}, timeout=60)
    data = r.get("data") or {}
    mined = data.get("mined_count") or 0
    assert mined == 0, (
        f"expected no mining through wall; mined_count={mined}, full={r}"
    )
    assert rcon.block_is(-4, 65, 0, "stone"), "hidden stone was mined — LOS guard failed"
    assert rcon.block_is(-1, 65, 0, "cobblestone"), "occluder was wrongly removed"


@pytest.mark.functional
def test_collect_refuses_block_behind_sealed_shelter(bot, rcon, arena, config, mine_arena):
    """C: bot sealed in cobble shelter, hidden stone at (0,65,0) outside.
    NO_VISIBLE_BLOCKS, stone stays."""
    world = config["mc"]["world"]
    walls = []
    for (dx, dy, dz) in [
        (1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1),
        (1, 1, 0), (-1, 1, 0), (0, 1, 1), (0, 1, -1),
        (0, 2, 0),
    ]:
        walls.append(
            f"execute in {world} run setblock {3 + dx} {65 + dy} {dz} minecraft:cobblestone"
        )
    walls.append(f"execute in {world} run setblock 0 65 0 minecraft:stone")
    _stage_arena_and_bot(rcon, world, walls)
    hold_reactive(bot)
    r = bot.post("/action/collect", {"block": "stone", "count": 1, "range": 10}, timeout=60)
    data = r.get("data") or {}
    mined = data.get("mined_count") or 0
    assert mined == 0, r
    assert rcon.block_is(0, 65, 0, "stone"), "hidden stone was mined — LOS guard failed"


@pytest.mark.functional
@pytest.mark.slow
def test_collect_mines_multiple_blocks_from_3x3x3_deposit(bot, rcon, arena, config, mine_arena):
    """D: 3×3×3 stone deposit at x∈{-6,-5,-4}, y∈{65,66,67}, z∈{-1,0,1}.
    One collect call mines ≥6 of 27 (was 1-3 before the multi-mine fix)."""
    world = config["mc"]["world"]
    cmds = []
    for x in (-6, -5, -4):
        for y in (65, 66, 67):
            for z in (-1, 0, 1):
                cmds.append(f"execute in {world} run setblock {x} {y} {z} minecraft:stone")
    _stage_arena_and_bot(rcon, world, cmds)
    hold_reactive(bot)
    r = bot.post("/action/collect", {"block": "cobblestone", "count": 8, "range": 12}, timeout=120)
    data = r.get("data") or {}
    mined = data.get("mined_count") or 0
    assert mined >= 6, f"mined only {mined}/8 — multi-mine logic regressed"


@pytest.mark.functional
@pytest.mark.slow
def test_collect_does_not_dive_pond_for_underwater_candidates(bot, rcon, arena, config, mine_arena):
    """E: 2 dry stones at x=-5,-4 + pond at z=6..10. Collect must exhaust
    the deposit without picking up the underwater stones (would walk the
    bot into the pond and stall)."""
    world = config["mc"]["world"]
    cmds = [
        f"execute in {world} run setblock -5 65 0 minecraft:stone",
        f"execute in {world} run setblock -4 65 0 minecraft:stone",
    ]
    for z in range(6, 11):
        for x in range(-3, 4):
            cmds.append(f"execute in {world} run setblock {x} 64 {z} minecraft:water")
    _stage_arena_and_bot(rcon, world, cmds)
    hold_reactive(bot)
    r = bot.post("/action/collect", {"block": "cobblestone", "count": 6, "range": 12}, timeout=90)
    data = r.get("data") or {}
    mined = data.get("mined_count") or 0
    pos = bot.position()
    assert mined >= 2, f"deposit not consumed (mined={mined})"
    assert rcon.block_is(-5, 65, 0, "air"), "dry deposit at x=-5 not consumed"
    assert rcon.block_is(-4, 65, 0, "air"), "dry deposit at x=-4 not consumed"
    # Bot ended outside the pond (z<5 or y>=65).
    assert pos.get("z", 0) < 5 or pos.get("y", 65) >= 65, f"bot ended in pond at {pos}"
