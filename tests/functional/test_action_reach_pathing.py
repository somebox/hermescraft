"""F55.3: coord-targeting actions auto-pathfind to within reach.

Migrated from scripts/test-action-reach-pathing.py with assertion
upgrades for scenarios A and D (inventory flagged them as shallow
`passed = ok` — they now verify the bot actually moved and that the
side effect actually landed).

Verifies that deposit/withdraw/list_container/interact:
  1. Auto-pathfind to within reach before acting.
  2. Cap the pathfind at 8s wallclock.
  3. Return structured OUT_OF_RANGE if pathfind fails.

(`mc chest_search` is a memory query — doesn't visit the chest — so
it doesn't need reach precheck and isn't covered here.)

Scenarios:
  A: bot 10m from chest, list_container → auto-pathfind + ok + bot reached.
  B: bot adjacent, list_container → ok + no pathfind movement (dt < 3s).
  C: bot trapped in bedrock cage, deposit far chest → OUT_OF_RANGE.
  D: bot 10m from lever, interact → auto-pathfind + ok + lever flipped.
"""

from __future__ import annotations

import math
import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def reach_arena(rcon, arena, tester_bot, config):
    """Larger flat region (61×61) so the 25-block test distances stay
    inside the cleared area. Each test places its own props."""
    tester_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-30, 64, -30, 30, 80, 30), floor="stone")
    rcon.run("clear Tester")
    arena.settle()
    yield
    arena.flat_arena((-30, 60, -30, 30, 80, 30), floor="stone")


def _distance(p: dict, x: float, y: float, z: float) -> float:
    return math.sqrt((p.get("x", 0) - x) ** 2 + (p.get("y", 0) - y) ** 2 + (p.get("z", 0) - z) ** 2)


@pytest.mark.functional
def test_chest_reach_pathfinds_from_10m_away(bot, rcon, arena, config, reach_arena):
    """A: chest at (10,65,0), bot at (0,65,0). After list_container the bot
    must end up within reach (≤4.5 blocks) of the chest — proving the
    auto-pathfind actually ran, not just that the verb returned ok=true.
    """
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 10 65 0 minecraft:chest",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    r = bot.post("/action/list_container", {"x": 10, "y": 65, "z": 0}, timeout=20)
    assert r.get("ok"), r
    # Inventory-flagged upgrade: verify bot actually moved within reach.
    pos = bot.position()
    dist = _distance(pos, 10, 65, 0)
    assert dist <= 4.5, f"bot at {pos}, distance {dist:.2f} > 4.5 — pathfind didn't run"


@pytest.mark.functional
def test_chest_adjacent_returns_fast_with_no_pathfind(bot, rcon, arena, config, reach_arena):
    """B: bot at (1,65,0) adjacent to chest at (0,65,0). list_container
    should return in well under 3s — pathfind not needed."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 0 65 0 minecraft:chest",
        f"execute in {world} run tp Tester 1 65 0 90 0",
    ])
    arena.settle()
    t0 = time.time()
    r = bot.post("/action/list_container", {"x": 0, "y": 65, "z": 0}, timeout=15)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    assert elapsed < 3.0, f"adjacent list_container took {elapsed:.2f}s — pathfind ran when it shouldn't"


@pytest.mark.functional
def test_chest_unreachable_returns_out_of_range(bot, rcon, arena, config, reach_arena):
    """C: bot trapped in a bedrock 1×2×1 cage with chest 25m away. deposit
    must return OUT_OF_RANGE within 12s (the 8s pathfind cap + slack)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 25 65 0 minecraft:chest",
        f"execute in {world} run tp Tester 0 65 0 90 0",
        "clear Tester",
        f"execute in {world} run give Tester minecraft:cobblestone 8",
        # Six-sided bedrock cage around foot+head cells of (0,65,0).
        f"execute in {world} run setblock 1 65 0 minecraft:bedrock",
        f"execute in {world} run setblock 1 66 0 minecraft:bedrock",
        f"execute in {world} run setblock -1 65 0 minecraft:bedrock",
        f"execute in {world} run setblock -1 66 0 minecraft:bedrock",
        f"execute in {world} run setblock 0 65 1 minecraft:bedrock",
        f"execute in {world} run setblock 0 66 1 minecraft:bedrock",
        f"execute in {world} run setblock 0 65 -1 minecraft:bedrock",
        f"execute in {world} run setblock 0 66 -1 minecraft:bedrock",
        f"execute in {world} run setblock 0 67 0 minecraft:bedrock",
    ])
    arena.settle()
    t0 = time.time()
    r = bot.post(
        "/action/deposit",
        {"x": 25, "y": 65, "z": 0, "item": "cobblestone", "count": 4},
        timeout=20,
    )
    elapsed = time.time() - t0
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "OUT_OF_RANGE", r
    assert elapsed < 12.0, f"OUT_OF_RANGE took {elapsed:.2f}s — pathfind didn't cap at 8s"


@pytest.mark.functional
def test_interact_reach_pathfinds_to_lever(bot, rcon, arena, config, reach_arena):
    """D: lever on top of a cobble pedestal at (10,66,0), bot at (0,65,0).
    After interact, the bot must be within reach AND the lever must have
    flipped to powered=true (inventory-flagged upgrade — original only
    checked ok=true).
    """
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 10 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock 10 66 0 minecraft:lever[face=floor,facing=north,powered=false]",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    r = bot.post("/action/interact", {"x": 10, "y": 66, "z": 0}, timeout=20)
    assert r.get("ok"), r
    pos = bot.position()
    dist = _distance(pos, 10, 66, 0)
    assert dist <= 4.5, f"bot at {pos}, distance {dist:.2f} > 4.5 — pathfind didn't run"
    # Side effect: lever's powered state flipped.
    assert rcon.block_is(10, 66, 0, "lever[powered=true]"), "lever didn't toggle despite interact ok=true"
