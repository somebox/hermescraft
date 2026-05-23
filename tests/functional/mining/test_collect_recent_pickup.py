"""F72: `mc collect <item> N` short-circuits via recent auto-pickup.

Migrated from scripts/test-collect-recent-pickup.py. After `mc dig X Y Z`
the dropped item often auto-magnets into inventory immediately
(mineflayer's 1.5-block pickup radius covers the dig target). A
follow-up `mc collect <item> 1` historically returned NO_VISIBLE_BLOCKS
because there were no drops left on the ground — F72 detects "agent
just got this from a dig" via the recentPickups cache and reports
success with source="recent_pickup".

Scenarios:
  A: dig andesite + collect → ok=true, source="recent_pickup".
  B: collect with no recent dig of that item → NOT short-circuited
     (either NO_VISIBLE_BLOCKS or scout path; never source=recent_pickup).
"""

from __future__ import annotations

import pytest


@pytest.fixture
def dig_and_collect_arena(rcon, arena, tester_bot, config):
    """Cross-dim safe bring-home, then flat grass arena, andesite at
    (-2,65,2). Bot at (-2,65,1) facing north with a pickaxe + heal effect."""
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute as Tester at @s in {world} run tp @s 0 65 0",
    ])
    arena.settle_water()
    rcon.batch([
        f"execute in {world} run setblock -2 65 2 minecraft:andesite",
        "clear Tester",
        f"execute in {world} run give Tester minecraft:stone_pickaxe 1",
        f"execute in {world} run effect give Tester minecraft:instant_health 1 5",
        f"execute in {world} run tp Tester -2 65 1 0 0",
    ])
    arena.settle_water()
    yield
    arena.forceload_remove_all()


@pytest.fixture
def empty_arena(rcon, arena, tester_bot, config):
    """Flat grass arena with NO ore — for the "no recent dig" scenario."""
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        "clear Tester",
        f"execute in {world} run give Tester minecraft:stone_pickaxe 1",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    arena.settle()
    yield
    arena.forceload_remove_all()


@pytest.mark.functional
def test_collect_short_circuits_via_recent_pickup(bot, dig_and_collect_arena):
    """A: dig andesite, wait for the magnet/pickup to land it in inventory,
    then mc collect andesite 1 → source=recent_pickup."""
    bot.post("/action/goto_near", {"x": -2, "y": 65, "z": 2, "range": 1}, timeout=15)
    dig = bot.post("/action/dig", {"x": -2, "y": 65, "z": 2}, timeout=30)
    assert dig.get("ok"), dig

    # Wait for auto-magnet OR explicit pickup fallback.
    count = bot.inventory_delta("andesite", timeout=2.0, baseline=0, fallback_pickup=True)
    assert count >= 1, f"andesite never reached inventory (count={count})"

    c = bot.post("/action/collect", {"block": "andesite", "count": 1}, timeout=30)
    assert c.get("ok"), c
    assert (c.get("data") or {}).get("source") == "recent_pickup", c


@pytest.mark.functional
def test_collect_does_not_use_recent_pickup_for_unfetched_item(bot, empty_arena):
    """B: bot never dug diamond_ore — collect must NOT short-circuit via
    recent_pickup. Either returns NO_VISIBLE_BLOCKS (ok=false) or some
    other source. The check: source != 'recent_pickup'."""
    c = bot.post("/action/collect", {"block": "diamond_ore", "count": 1}, timeout=30)
    source = (c.get("data") or {}).get("source") if c.get("ok") else None
    assert source != "recent_pickup", c
