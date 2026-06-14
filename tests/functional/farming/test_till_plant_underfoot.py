"""till/plant: step off target column when bot is standing on it."""

from __future__ import annotations

import pytest


@pytest.fixture
def underfoot_arena(functional_world, rcon, arena, config):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        f"execute in {world} run fill -2 64 -2 2 64 2 minecraft:grass_block",
        "clear Tester",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
        "gamemode survival Tester",
        f"execute in {world} run tp Tester 0.5 65 0.5 0 0",
    ])
    arena.settle_default()
    yield
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])


@pytest.mark.functional
@pytest.mark.functional_core
def test_till_steps_off_when_standing_on_target(bot, rcon, arena, config, underfoot_arena):
    world = config["mc"]["world"]
    target_x, target_y, target_z = 0, 64, 0
    rcon.batch([
        "give Tester minecraft:wooden_hoe 1",
        f"execute in {world} run tp Tester 0.5 65 0.5 0 0",
    ])
    arena.settle_default()

    r = None
    for _attempt in range(3):
        r = bot.post("/action/till", {"x": target_x, "y": target_y, "z": target_z}, timeout=30)
        if r.get("ok"):
            break
        rcon.run(f"execute in {world} run tp Tester 0.5 65 0.5 0 0")
        arena.settle_fast()
    assert r.get("ok"), r
    step = r.get("data", {}).get("stepped_off_target")
    assert step is not None, r
    assert step["x"] != target_x or step["z"] != target_z, step


@pytest.mark.functional
def test_plant_steps_off_when_standing_on_target(bot, rcon, arena, config, underfoot_arena):
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 0 64 0 minecraft:farmland[moisture=7]",
        f"execute in {world} run gamemode creative Tester",
        f"execute in {world} run tp Tester 0.5 65 0.5 0 0",
        f"execute in {world} run gamemode survival Tester",
        "give Tester minecraft:wheat_seeds 4",
    ])
    arena.settle_default()
    assert rcon.block_is(0, 64, 0, "farmland")

    r = bot.post("/action/plant", {
        "item": "wheat_seeds",
        "x": 0, "y": 65, "z": 0,
    }, timeout=30)
    assert r.get("ok"), r
    step = r.get("data", {}).get("stepped_off_target")
    assert step is not None, r
    crop = r["data"]["target_coord"]
    inspect = bot.post("/action/inspect", {"x": crop["x"], "y": crop["y"], "z": crop["z"]}, timeout=5)
    assert inspect.get("data", {}).get("block", {}).get("name") == "wheat", inspect
