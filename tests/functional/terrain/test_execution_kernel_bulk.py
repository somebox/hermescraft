"""Arena smoke for execution-kernel `dig_area` (_useKernel on request).

Ordering/idempotence/planner proofs live under `bot/test/**` (dig-area-order,
level-solid-target, level-ground execute rerun, wall-kernel-smoke,
clear-strip-contract). This file keeps one all-air postflight smoke.
"""

from __future__ import annotations

import pytest

GROUND_Y = 64
FEET_Y = 65


@pytest.fixture
def bulk_arena(rcon, arena, config):
    world = config["mc"]["world"]
    arena.settle_default()
    rcon.batch([
        "clear Tester",
        "give Tester minecraft:stone_pickaxe 1",
        "give Tester minecraft:bread 16",
    ])
    arena.settle_fast()
    yield world


@pytest.mark.functional
@pytest.mark.functional_core
def test_dig_area_kernel_3x3_all_air(bot, rcon, arena, config, bulk_arena):
    """Kernel dig_area on one dirt layer — all cells become air."""
    world = bulk_arena
    x1, z1, x2, z2 = 10, 10, 12, 12
    y = GROUND_Y
    rcon.batch([
        f"execute in {world} run fill {x1} {y} {z1} {x2} {y} {z2} minecraft:dirt",
        f"execute in {world} run fill {x1} {y + 1} {z1} {x2} {y + 4} {z2} minecraft:air",
        f"execute in {world} run tp Tester {x1 - 1} {FEET_Y} {z1 - 1} 45 0",
    ])
    arena.settle_water()

    r = bot.post(
        "/action/dig_area",
        {
            "x1": x1, "y1": y, "z1": z1,
            "x2": x2, "y2": y, "z2": z2,
            "safe": False,
            "clear_stand": False,
            "pickup": False,
            "_useKernel": True,
        },
        timeout=90,
    )
    assert r.get("ok") is not False or r.get("dug", 0) >= 9, r
    for x in range(x1, x2 + 1):
        for z in range(z1, z2 + 1):
            assert rcon.block_is(x, y, z, "air"), f"({x},{y},{z}) should be air"
