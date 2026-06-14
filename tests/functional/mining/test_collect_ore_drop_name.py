"""Task #33: collect iron_ore reports raw_iron in envelope (live smoke)."""

from __future__ import annotations

import pytest

from tests._lib.scenario_verify import assert_block_is, assert_goto_ok


@pytest.fixture
def ore_arena(functional_world, rcon, arena, tester_bot, config):
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute as Tester at @s in {world} run tp @s 0 65 0",
    ])
    arena.settle_water()
    rcon.batch([
        f"execute in {world} run setblock -2 65 2 minecraft:iron_ore",
        "clear Tester",
        f"execute in {world} run give Tester minecraft:iron_pickaxe 1",
        f"execute in {world} run effect give Tester minecraft:instant_health 1 5",
        f"execute in {world} run tp Tester 0 65 1 0 0",
    ])
    arena.settle_water()
    yield


@pytest.mark.functional
@pytest.mark.functional_core
def test_collect_iron_ore_reports_raw_iron_drop_name(bot, rcon, config, ore_arena):
    assert_goto_ok(bot, {"x": -2, "y": 65, "z": 2, "range": 1}, timeout=20)
    r = bot.post("/action/collect", {"block": "iron_ore", "count": 1}, timeout=45)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("expected_drop_item") == "raw_iron", data
    assert data.get("drop_item_gained", 0) >= 1, data
    inv_gain = data.get("inventory_gain") or {}
    assert inv_gain.get("raw_iron", 0) >= 1, inv_gain
    assert_block_is(rcon, -2, 65, 2, "air")
