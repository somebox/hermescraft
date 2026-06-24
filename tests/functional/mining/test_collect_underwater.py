"""F54.4 live smoke: `mc dig` refuses SUBMERGED while bot is in water.

TARGET_IN_WATER / dry-over-flooded collect paths are in
`bot/test/actions/mining-collect.test.js`. Spatial need: water_column
(extreme — audit lists outside default ±16 until pad migration).
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def underwater_arena(rcon, arena, tester_bot, config):
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.batch([
        f"execute in {world} run fill -10 60 -10 20 80 20 minecraft:air",
        f"execute in {world} run fill -10 60 -10 20 63 20 minecraft:stone",
        f"execute in {world} run fill -10 64 -10 20 64 20 minecraft:grass_block",
    ])
    arena.settle_water()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.run(f"execute in {world} run fill -10 60 -10 20 80 20 minecraft:air")


@pytest.mark.functional
def test_dig_while_submerged_returns_submerged(bot, rcon, arena, config, underwater_arena):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 5 64 0 minecraft:water",
        f"execute in {world} run setblock 5 65 0 minecraft:water",
        f"execute in {world} run setblock 4 64 0 minecraft:stone",
        f"execute in {world} run tp Tester 5.5 64 0.5 0 0",
    ])
    arena.settle_water()
    r = bot.post("/action/dig", {"x": 4, "y": 64, "z": 0}, timeout=15)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "SUBMERGED", r
    assert obs.get("bot_in_water") is True, obs
