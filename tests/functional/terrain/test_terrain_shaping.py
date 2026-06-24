"""Live smoke: `mc level_ground execute=true` on a messy field.

Planner/idempotence proofs live in `bot/test/actions/level-ground*.test.js`.
Fill overwrite + scattered collect moved to Node or dropped as duplicate arena.
Spatial need: messy_field. Pad: Origin-adjacent bbox (20,10)–(23,13).
"""

from __future__ import annotations

import pytest

GROUND_Y = 64
FEET_Y = 65


@pytest.fixture
def terrain_arena(rcon, arena, config):
    arena.settle_default()
    rcon.batch([
        "clear Tester",
        "give Tester minecraft:stone_pickaxe 1",
        "give Tester minecraft:cobblestone 64",
        "give Tester minecraft:bread 16",
    ])
    arena.settle_fast()
    yield


@pytest.mark.functional
def test_level_ground_execute_messy(bot, rcon, arena, config, terrain_arena):
    world = config["mc"]["world"]
    arena.scatter_holes_and_pillars(
        bbox=(20, 10, 23, 13),
        ground_y=GROUND_Y,
        n_holes=3,
        n_pillars=2,
        max_hole_depth=2,
        max_pillar_height=3,
        seed=7777,
    )
    rcon.run(f"execute in {world} run tp Tester 18 {FEET_Y} 11 90 0")
    arena.settle_water()

    r_plan = bot.post("/action/level_ground", {
        "x1": 20, "z1": 10, "x2": 23, "z2": 13,
    }, timeout=30)
    assert r_plan.get("ok"), r_plan
    plan = r_plan.get("data") or {}
    assert plan.get("summary", {}).get("holes_n") == 3, plan

    r_exec = bot.post("/action/level_ground", {
        "x1": 20, "z1": 10, "x2": 23, "z2": 13,
        "execute": True,
        "block": "cobblestone",
    }, timeout=120)
    assert r_exec.get("ok"), r_exec
    assert (r_exec.get("data") or {}).get("executed") is True

    misses = []
    for x in range(20, 24):
        for z in range(10, 14):
            if not (rcon.block_is(x, GROUND_Y + 1, z, "air") and not rcon.block_is(x, GROUND_Y, z, "air")):
                misses.append((x, GROUND_Y, z))
    assert len(misses) <= 1, f"level_ground left {len(misses)} non-level columns: {misses[:5]}"
