"""F50 / pickup hardening: pickup pass shouldn't stall on blocked drops.

Migrated from scripts/test-pickup-blocked.py. Three scenarios stress
the pickup verb's pathfinder + centroid broom-sweep:
  A: single drop, clear path — fast pickup (<3s).
  B: single drop blocked by a cobble block between bot and drop —
     pickup must route around or jump over (<4s).
  C: three drops scattered at radius ~2 — broom-sweep grabs all three
     within 8s.

The fix bundled in pickup: GoalNear radius 1.0→1.5, per-drop timeout
1500ms, centroid sweep at the top of each attempt.
"""

from __future__ import annotations

import time

import pytest


def _spawn_cobble_drop(rcon, world: str, x: float, y: float, z: float) -> None:
    """rcon-summon a cobblestone item entity. PickupDelay:0 + Motion zero
    so the drop settles immediately and is pickup-eligible."""
    rcon.run(
        f"execute in {world} run summon item {x} {y} {z} "
        f'{{Item:{{id:"minecraft:cobblestone",count:1}},'
        f"PickupDelay:0,Age:0,Motion:[0d,0d,0d]}}"
    )


@pytest.fixture
def pickup_arena(rcon, arena, flint_bot, config):
    """Grass floor, peaceful, no mob spawning. Bot at (3,65,1) facing west.
    Each test spawns its own drops + obstacles."""
    world = config["mc"]["world"]
    flint_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-8, 64, -8, 8, 70, 8), floor="grass_block")
    rcon.batch([
        f"execute in {world} run tp Flint 3 65 1 270 0",  # face west (-x)
        "clear Flint",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
    ])
    # Hold mode — disables the reactive layer's auto-pickup so the test
    # measures the EXPLICIT pickup verb only.
    try:
        flint_bot.post("/action/mode", {"name": "hold"}, timeout=5)
    except Exception:
        pass
    arena.settle(seconds=3.5)
    yield
    arena.flat_arena((-8, 60, -8, 8, 70, 8), floor="grass_block")
    rcon.run(f"execute in {world} run kill @e[type=item,distance=..40]")


def _do_pickup_and_measure(bot, expected_gain: int, time_limit_s: float) -> None:
    pre = bot.inventory().get("cobblestone", 0)
    t0 = time.time()
    r = bot.post("/action/pickup", {}, timeout=30)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    time.sleep(0.4)
    post = bot.inventory().get("cobblestone", 0)
    gained = post - pre
    assert gained >= expected_gain, f"gained {gained} < {expected_gain}; elapsed {elapsed:.2f}s"
    assert elapsed <= time_limit_s, f"pickup took {elapsed:.2f}s > {time_limit_s}s"


@pytest.mark.functional
def test_pickup_single_drop_clear_path(bot, rcon, config, pickup_arena):
    """A: drop at (1.5,65.5,1.5), bot at (3,65,1), nothing in the way."""
    _spawn_cobble_drop(rcon, config["mc"]["world"], 1.5, 65.5, 1.5)
    time.sleep(0.3)
    _do_pickup_and_measure(bot, expected_gain=1, time_limit_s=3.0)


@pytest.mark.functional
def test_pickup_single_drop_behind_block(bot, rcon, config, pickup_arena):
    """B: cobblestone block at (2,65,1) between bot (3,65,1) and drop (1,65,1)."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run setblock 2 65 1 minecraft:cobblestone")
    _spawn_cobble_drop(rcon, world, 1.5, 65.5, 1.5)
    time.sleep(0.3)
    _do_pickup_and_measure(bot, expected_gain=1, time_limit_s=4.0)


@pytest.mark.functional
def test_pickup_broom_sweeps_three_scattered_drops(bot, rcon, config, pickup_arena):
    """C: three drops at radius ~2 — centroid sweep grabs all three."""
    world = config["mc"]["world"]
    _spawn_cobble_drop(rcon, world, 1.5, 65.5, 1.5)
    _spawn_cobble_drop(rcon, world, 4.5, 65.5, 3.5)
    _spawn_cobble_drop(rcon, world, 2.5, 65.5, -1.5)
    time.sleep(0.3)
    _do_pickup_and_measure(bot, expected_gain=3, time_limit_s=8.0)
