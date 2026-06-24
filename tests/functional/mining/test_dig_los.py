"""F67 live smoke: dig succeeds with clear line of sight.

Refusal path (NO_LINE_OF_SIGHT, block unchanged) is covered in
`bot/test/actions/mining-dig.test.js`. Spatial need: door_sealed_box tier
ARENA_SMALL. Specialty pad: Origin. Observer: (0, 72, 0).
"""

from __future__ import annotations

import pytest


@pytest.fixture
def los_arena(rcon, arena, tester_bot, config):
    world = config["mc"]["world"]
    from tests._lib.functional_fixtures import ensure_arena_forceload

    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        "clear Tester",
        f"execute in {world} run give Tester minecraft:stone_pickaxe 1",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    ensure_arena_forceload(rcon, world)


@pytest.mark.functional
def test_dig_succeeds_when_target_in_clear_view(bot, rcon, arena, config, los_arena):
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run setblock 2 65 0 minecraft:diorite")
    arena.settle()
    r = bot.post("/action/dig", {"x": 2, "y": 65, "z": 0}, timeout=30)
    assert r.get("ok"), r
    assert rcon.block_is(2, 65, 0, "air"), "dig returned ok but target is not air"
