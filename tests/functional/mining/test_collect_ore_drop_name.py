"""Task #33: `mc collect iron_ore N` succeeds when the block drops as raw_iron.

circuit-v7 (2026-05-22): Steve mined all 4 W1 iron_ore blocks but reported
"Have 0 iron_ore in inventory" — the success message checked inventory by
the BLOCK name (iron_ore) when MC 1.17+ has iron_pickaxe drop raw_iron
instead. The drops were collected correctly but the agent interpreted the
"0 iron_ore" message as failure, then tried again, and again, until the
drops despawned (5 min item timer).

This test locks down the fix: the success envelope reports the actual
drop item name (`data.expected_drop_item`) and the inventory gain in
that item (`data.drop_item_gained`). The result string leads with the
inventory truth, e.g. "Collected 1/1 raw_iron (drops as raw_iron) in
inventory (mined 1 blocks)."

Scenarios:
  A: iron_ore + iron_pickaxe → expected_drop_item=raw_iron, raw_iron
     in inventory_gain. Result message mentions raw_iron.
  B: cobblestone (self-drop) → expected_drop_item=cobblestone, no
     "drops as X" tag in the message.
"""

from __future__ import annotations

import re

import pytest


@pytest.fixture
def ore_arena(rcon, arena, tester_bot, config):
    """Arena: iron_ore at (-2, 65, 2), cobblestone at (2, 65, 2), bot with
    iron_pickaxe at (0, 65, 1)."""
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute as Tester at @s in {world} run tp @s 0 65 0",
    ])
    arena.settle_water()
    rcon.batch([
        f"execute in {world} run setblock -2 65 2 minecraft:iron_ore",
        f"execute in {world} run setblock 2 65 2 minecraft:cobblestone",
        "clear Tester",
        f"execute in {world} run give Tester minecraft:iron_pickaxe 1",
        f"execute in {world} run effect give Tester minecraft:instant_health 1 5",
        f"execute in {world} run tp Tester 0 65 1 0 0",
    ])
    arena.settle_water()
    yield
    arena.forceload_remove_all()


@pytest.mark.functional
def test_collect_iron_ore_reports_raw_iron_drop_name(bot, ore_arena):
    """A: iron_ore mined with iron_pickaxe drops raw_iron. The result
    envelope must surface this so the agent doesn't loop checking for
    iron_ore in inventory."""
    bot.post("/action/goto_near", {"x": -2, "y": 65, "z": 2, "range": 1}, timeout=15)
    r = bot.post("/action/collect", {"block": "iron_ore", "count": 1}, timeout=45)
    assert r.get("ok"), r
    data = r.get("data") or {}
    # The block_name field reflects what the agent asked for.
    # The expected_drop_item field is what actually landed in inventory.
    assert data.get("expected_drop_item") == "raw_iron", \
        f"expected_drop_item should be raw_iron for iron_ore; got {data.get('expected_drop_item')}"
    assert data.get("drop_item_gained", 0) >= 1, \
        f"drop_item_gained should be >=1; got {data.get('drop_item_gained')}"
    # inventory_gain dict must include raw_iron.
    inv_gain = data.get("inventory_gain") or {}
    assert inv_gain.get("raw_iron", 0) >= 1, f"inventory_gain missing raw_iron: {inv_gain}"
    # Result message must say "drops as raw_iron" so the agent's mental
    # model matches reality.
    result = r.get("result") or ""
    assert "drops as raw_iron" in result, f"result should mention drops-as: {result!r}"
    # The message leads with inventory truth: "Collected N/N raw_iron (drops
    # as raw_iron) in inventory ...". The `(drops as …)` note sits between the
    # item name and "in inventory", so match across it rather than as one
    # contiguous substring.
    assert re.search(r"raw_iron.*in inventory", result), \
        f"result should report raw_iron in inventory: {result!r}"


@pytest.mark.functional
def test_collect_cobblestone_self_drop_no_extra_note(bot, ore_arena):
    """B: cobblestone is a self-drop (stone with iron_pickaxe drops cobblestone,
    but here we're mining cobblestone blocks directly — drop is cobblestone).
    The result message should NOT include a 'drops as X' tag since drop name
    matches block name."""
    bot.post("/action/goto_near", {"x": 2, "y": 65, "z": 2, "range": 1}, timeout=15)
    r = bot.post("/action/collect", {"block": "cobblestone", "count": 1}, timeout=45)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("expected_drop_item") == "cobblestone", data
    result = r.get("result") or ""
    assert "drops as" not in result, \
        f"self-drop blocks should not get a 'drops as' tag: {result!r}"
