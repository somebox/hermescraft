"""F55.1: `mc place` auto-equips a block from inventory.

Migrated from scripts/test-place-fresh-craft.py with assertion upgrades
for scenarios A and B (inventory-flagged: legacy only checked ok=true,
now verifies the crafting_table actually appeared at the target coord).

Scenarios:
  A: craft crafting_table from oak_planks, unequip, then mc place →
     ok + block present at target coord.
  B: same with bot already having crafting_table in inv (no craft) →
     ok + block present at target coord.
  C: bot has no crafting_table → INVENTORY_MISSING error (no side effect).
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def craft_place_arena(rcon, arena, tester_bot, config):
    """Stone floor at y=64, bot at (0,65,0) facing east, inventory cleared."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="stone")
    rcon.batch([
        f"execute in {world} run tp Tester 0 65 0 90 0",
        "clear Tester",
    ])
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="stone")


@pytest.mark.functional
def test_place_after_fresh_craft_succeeds(bot, rcon, arena, craft_place_arena):
    """A: craft a crafting_table, unequip, place at (2,65,0). Verify the
    block actually appeared at the target — not just ok=true (inventory
    flag fix)."""
    rcon.run("give Tester minecraft:oak_planks 4")
    time.sleep(0.5)
    cr = bot.post("/action/craft", {"item": "crafting_table", "count": 1}, timeout=20)
    assert cr.get("ok"), cr
    bot.post("/action/unequip", {}, timeout=5)
    time.sleep(0.3)
    r = bot.post("/action/place", {"block": "crafting_table", "x": 2, "y": 65, "z": 0}, timeout=15)
    assert r.get("ok"), r
    assert rcon.block_is(2, 65, 0, "crafting_table"), "place ok=true but block not present"


@pytest.mark.functional
def test_place_from_inventory_with_empty_hand(bot, rcon, arena, craft_place_arena):
    """B: inv has crafting_table, hand empty → place auto-equips and the
    block is actually placed (inventory flag fix)."""
    rcon.run("give Tester minecraft:crafting_table 1")
    time.sleep(0.8)
    bot.post("/action/unequip", {}, timeout=5)
    time.sleep(0.3)
    r = bot.post("/action/place", {"block": "crafting_table", "x": 2, "y": 65, "z": 0}, timeout=15)
    assert r.get("ok"), r
    assert rcon.block_is(2, 65, 0, "crafting_table"), "place ok=true but block not present"


@pytest.mark.functional
def test_place_without_inventory_returns_inventory_missing(bot, rcon, craft_place_arena):
    """C: no crafting_table in inventory → INVENTORY_MISSING error, no side effect."""
    time.sleep(0.5)
    r = bot.post("/action/place", {"block": "crafting_table", "x": 2, "y": 65, "z": 0}, timeout=10)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "INVENTORY_MISSING", r
    assert rcon.block_is(2, 65, 0, "air"), "INVENTORY_MISSING but a block was still placed"
