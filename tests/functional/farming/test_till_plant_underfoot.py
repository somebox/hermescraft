"""till/plant: step off target column when bot is standing on it.

Native activateBlock / placeBlock silently no-op when the bot's hitbox
occludes the target face. Pre-fix the agent fell back to the PaperMCP
setblock path every time, which is slower and bypasses the normal
interaction. These tests verify the new step-off behaviour:

- till: bot standing ON the grass cell to till should move laterally,
  till the cell from the side, return ok with stepped_off_target in data.
- plant: bot standing ON the farmland (feet in the crop cell to be) should
  move laterally, plant from the side.
"""

from __future__ import annotations

import time

import pytest


@pytest.fixture
def underfoot_arena(rcon, config):
    """3x3 grass platform on stone, bot in the middle. Each test paints
    its own surface (grass for till, farmland for plant) and ensures the
    bot starts standing on the target cell.
    """
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        # Default surface: grass (for till test). Plant test overwrites the center cell.
        f"execute in {world} run fill -2 64 -2 2 64 2 minecraft:grass_block",
        "clear Tester",
        f"effect clear Tester",
        f"effect give Tester minecraft:saturation 600 1",
        "gamemode survival Tester",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(1.5)
    yield
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 60 -5 5 80 5 minecraft:air",
        f"execute in {world} run fill -5 62 -5 5 63 5 minecraft:stone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])


@pytest.mark.functional
def test_till_steps_off_when_standing_on_target(bot, rcon, config, underfoot_arena):
    """Bot at (0, 65, 0) standing on grass at (0, 64, 0). Till (0, 64, 0)
    → bot should step laterally first, then till from the side."""
    rcon.batch([
        "give Tester minecraft:wooden_hoe 1",
    ])
    time.sleep(1.0)

    before = bot.position() or {}
    assert before.get("y") == 65, f"bot should be standing on grass at y=65, got {before}"
    bx0, bz0 = int(before["x"]), int(before["z"])
    # The target cell is the block directly beneath the bot's feet.
    target_x, target_y, target_z = bx0, 64, bz0

    r = bot.post("/action/till", {"x": target_x, "y": target_y, "z": target_z}, timeout=30)
    assert r.get("ok"), r

    # Step-off info should be present in the response.
    step = r.get("data", {}).get("stepped_off_target")
    assert step is not None, f"expected stepped_off_target in response data, got {r}"
    assert step["x"] != target_x or step["z"] != target_z, (
        f"stepped_off_target should be a different column from target, got {step}"
    )

    # The target should now be farmland.
    inspect = bot.post("/action/inspect", {"x": target_x, "y": target_y, "z": target_z}, timeout=5)
    assert inspect.get("data", {}).get("block", {}).get("name") == "farmland", inspect

    # The native path (not papermcp fallback) should have worked; result envelope
    # should not include `fallback`.
    assert "fallback" not in r.get("data", {}), (
        f"step-off should let native interaction succeed without PaperMCP fallback, got {r}"
    )


@pytest.mark.functional
def test_plant_steps_off_when_standing_on_target(bot, rcon, config, underfoot_arena):
    """Bot standing on farmland at (0, 64, 0). Plant wheat_seeds at (0, 65, 0)
    — the crop cell IS the bot's foot cell. Should step laterally first."""
    world = config["mc"]["world"]
    # Replace the center grass block with farmland (no plant yet).
    rcon.batch([
        f"execute in {world} run setblock 0 64 0 minecraft:farmland",
        f"execute in {world} run tp Tester 0 65 0 0 0",
        "give Tester minecraft:wheat_seeds 4",
    ])
    time.sleep(1.5)

    before = bot.position() or {}
    bx0, bz0 = int(before["x"]), int(before["z"])
    # The plant target is the cell where the bot's feet currently are.
    target_x, target_y, target_z = bx0, int(before["y"]), bz0

    r = bot.post("/action/plant", {
        "item": "wheat_seeds",
        "x": target_x, "y": target_y, "z": target_z,
    }, timeout=30)
    assert r.get("ok"), r

    step = r.get("data", {}).get("stepped_off_target")
    assert step is not None, f"expected stepped_off_target in response data, got {r}"

    # The plant cell — use the response's resolved target_coord (the action
    # adjusts upward when the request landed on the farmland row).
    crop = r["data"]["target_coord"]
    inspect = bot.post("/action/inspect", {"x": crop["x"], "y": crop["y"], "z": crop["z"]}, timeout=5)
    assert inspect.get("data", {}).get("block", {}).get("name") == "wheat", inspect

    assert "fallback" not in r.get("data", {}), (
        f"step-off should let native placeBlock succeed without PaperMCP fallback, got {r}"
    )
