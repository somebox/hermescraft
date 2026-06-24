"""Arena tests for execution-kernel bulk verbs (dig_area, level, wall).

Uses Tester HTTP actions against landfolk-test. dig_area tests pass
``_useKernel: true`` so they do not require ``HERMES_EXEC_KERNEL`` on the
bot process. level/wall/clear_strip kernel paths need the env flag on
Tester when those tests are extended — see docs/architecture/execution-kernel.md.
"""

from __future__ import annotations

import threading

import pytest

from tests._lib.dig_order_poll import max_horizontal_step, poll_cells_becoming_air

GROUND_Y = 64
FEET_Y = 65


@pytest.fixture
def bulk_arena(rcon, arena, config):
    """Pickaxe + fill blocks for shaping tests."""
    world = config["mc"]["world"]
    arena.settle_default()
    rcon.batch([
        "clear Tester",
        "give Tester minecraft:stone_pickaxe 1",
        "give Tester minecraft:cobblestone 64",
        "give Tester minecraft:dirt 64",
        "give Tester minecraft:bread 16",
    ])
    arena.settle_fast()
    yield world


@pytest.mark.functional
def test_dig_area_kernel_3x3_adjacent_sweep(bot, rcon, arena, config, bulk_arena):
    """Kernel dig_area on one layer: all cells break; same-Y steps stay local (no star-hop)."""
    world = bulk_arena
    x1, z1, x2, z2 = 10, 10, 12, 12
    y = GROUND_Y
    rcon.batch([
        f"execute in {world} run fill {x1} {y} {z1} {x2} {y} {z2} minecraft:dirt",
        f"execute in {world} run fill {x1} {y + 1} {z1} {x2} {y + 4} {z2} minecraft:air",
        f"execute in {world} run tp Tester {x1 - 1} {FEET_Y} {z1 - 1} 45 0",
    ])
    arena.settle_water()

    cells = [(x, y, z) for x in range(x1, x2 + 1) for z in range(z1, z2 + 1)]
    stop = threading.Event()
    order_box: list[list[tuple[int, int, int]]] = []

    def poll():
        order_box.append(
            poll_cells_becoming_air(rcon, cells, stop_event=stop, poll_interval_s=0.04),
        )

    poll_thread = threading.Thread(target=poll, daemon=True)
    poll_thread.start()
    try:
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
    finally:
        stop.set()
        poll_thread.join(timeout=5)

    assert r.get("ok") is not False or r.get("dug", 0) >= 9, r
    dug = r.get("dug") or (r.get("data") or {}).get("dug") or 0
    assert dug >= 8, f"expected ≥8/9 dug, got {r}"

    for x, _, z in cells:
        assert rcon.block_is(x, y, z, "air"), f"({x},{y},{z}) should be air"

    order = order_box[0] if order_box else []
    if len(order) >= 5:
        step = max_horizontal_step(order)
        assert step <= 2, (
            f"kernel layer sweep expected adjacent steps (≤2), got max {step}; order={order}"
        )


@pytest.mark.functional
def test_level_dig_above_solid_target(bot, rcon, arena, config, bulk_arena):
    """level must clear blocks above targetY when the target cell is already solid."""
    world = bulk_arena
    x, z = 15, 15
    rcon.batch([
        f"execute in {world} run fill {x} {GROUND_Y - 1} {z} {x} {GROUND_Y - 1} {z} minecraft:stone",
        f"execute in {world} run setblock {x} {GROUND_Y} {z} minecraft:stone",
        f"execute in {world} run setblock {x} {GROUND_Y + 1} {z} minecraft:dirt",
        f"execute in {world} run setblock {x} {GROUND_Y + 2} {z} minecraft:dirt",
        f"execute in {world} run fill {x} {GROUND_Y + 3} {z} {x} {GROUND_Y + 4} {z} minecraft:air",
        f"execute in {world} run tp Tester {x - 2} {FEET_Y} {z} 90 0",
    ])
    arena.settle_water()

    r = bot.post(
        "/action/level",
        {"x1": x, "z1": z, "x2": x, "z2": z, "y": GROUND_Y, "up": 8},
        timeout=120,
    )
    assert r.get("ok"), r
    data = r.get("data") or r
    assert (data.get("dug") or 0) >= 2, data
    assert rcon.block_is(x, GROUND_Y, z, "stone"), "target bed should stay solid"
    assert rcon.block_is(x, GROUND_Y + 1, z, "air"), "block above target should be cleared"
    assert rcon.block_is(x, GROUND_Y + 2, z, "air"), "top block above target should be cleared"


@pytest.mark.functional
def test_level_ground_execute_rerun_idempotent(bot, rcon, arena, config, bulk_arena):
    """Second level_ground execute on the same flat target mostly no-ops (resume-friendly)."""
    world = bulk_arena
    arena.scatter_holes_and_pillars(
        bbox=(20, 10, 23, 13),
        ground_y=GROUND_Y,
        n_holes=2,
        n_pillars=1,
        max_hole_depth=2,
        max_pillar_height=2,
        seed=9090,
    )
    rcon.run(f"execute in {world} run tp Tester 18 {FEET_Y} 11 90 0")
    arena.settle_water()

    body = {
        "x1": 20, "z1": 10, "x2": 23, "z2": 13,
        "execute": True,
        "block": "cobblestone",
    }
    r1 = bot.post("/action/level_ground", body, timeout=180)
    assert r1.get("ok"), r1
    exec1 = (r1.get("data") or {}).get("execute_result") or {}
    placed1 = exec1.get("placed") or 0

    r2 = bot.post("/action/level_ground", body, timeout=180)
    assert r2.get("ok"), r2
    exec2 = (r2.get("data") or {}).get("execute_result") or {}
    placed2 = exec2.get("placed") or 0
    skipped2 = exec2.get("skipped") or 0
    assert placed2 <= placed1, f"rerun should not place more than first pass; {exec1} -> {exec2}"
    assert skipped2 >= 0


@pytest.mark.functional
def test_wall_kernel_places_column(bot, rcon, arena, config, bulk_arena):
    """mc wall uses kernel runCells ordering; small column fully places."""
    world = bulk_arena
    x, z = 25, 25
    y1, y2 = GROUND_Y, GROUND_Y + 2
    rcon.batch([
        f"execute in {world} run fill {x - 1} {GROUND_Y - 1} {z - 1} {x + 1} {GROUND_Y - 1} {z + 1} minecraft:stone",
        f"execute in {world} run fill {x} {y1} {z} {x} {y2} {z} minecraft:air",
        f"execute in {world} run tp Tester {x - 2} {FEET_Y} {z} 90 0",
    ])
    arena.settle_water()

    r = bot.post(
        "/action/wall",
        {
            "block": "cobblestone",
            "x1": x, "y1": y1, "z1": z,
            "x2": x, "y2": y2, "z2": z,
        },
        timeout=120,
    )
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert (data.get("blocks_placed") or 0) >= 3, data
    for y in range(y1, y2 + 1):
        assert rcon.block_is(x, y, z, "cobblestone"), f"wall cell ({x},{y},{z}) missing"


@pytest.mark.functional
def test_clear_strip_clears_leaf_patch(bot, rcon, arena, config, bulk_arena):
    """clear_strip end-to-end on a small leaf box (batch dig via dig_area)."""
    world = bulk_arena
    x1, z1, x2, z2 = 28, 28, 30, 30
    y = 78
    rcon.batch([
        "give Tester minecraft:stone_axe 1",
        f"execute in {world} run fill {x1} {y} {z1} {x2} {y} {z2} minecraft:oak_leaves",
        f"execute in {world} run tp Tester 27 79 28 90 0",
    ])
    arena.settle_water()
    r = bot.post(
        "/action/clear_strip",
        {"x1": x1, "z1": z1, "x2": x2, "z2": z2, "y": y, "height": 1},
        timeout=120,
    )
    assert r.get("ok"), r
    data = r.get("data") or {}
    dug = data.get("dug") or 0
    assert dug >= 7, f"expected most of 9 leaf cells dug, got {data}"
    for x in range(x1, x2 + 1):
        for z in range(z1, z2 + 1):
            assert rcon.block_is(x, y, z, "air"), f"({x},{y},{z}) should be air"
