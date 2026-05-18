"""F56: `mc through` jump-nudges to step up onto an elevated door.

Migrated from scripts/test-through-elevated-door.py. Replicates the G22
scenario the prior F55.4 test missed: a walled PLATFORM (cobble at
y=65) with a door on the south wall (lower=y=66, upper=y=67), bot
outside at grass level. The bot must step UP onto the platform AND
walk through — mineflayer's `setControlState('forward')` doesn't jump
on its own, so `mc through` detects the stall and jump-nudges.

Scenarios:
  A: door on raised platform (y=66/67), bot 2 blocks south on grass.
     Through must succeed OR bot must end up past the door (z<12).
  B: door at same level as bot (no step-up). Sanity check; through
     should succeed or bot must end past the door (z<5).
"""

from __future__ import annotations

import time

import pytest


@pytest.fixture
def elev_arena(rcon, arena, tester_bot, config):
    """Grass-floored area (no sub-floor stone needed — platform built
    explicitly per test). Tester bot."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -15 60 -15 15 80 15 minecraft:air",
        f"execute in {world} run fill -15 60 -15 15 63 15 minecraft:stone",
        f"execute in {world} run fill -15 64 -15 15 64 15 minecraft:grass_block",
        "clear Tester",
    ])
    try:
        tester_bot.get("/status?lean=true", timeout=5)
    except Exception:
        pass
    arena.settle(seconds=1.0)
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill -15 60 -15 15 80 15 minecraft:air")


@pytest.mark.functional
def test_through_steps_up_onto_elevated_door(bot, rcon, config, elev_arena):
    """A: 4x4 platform at y=65 with 3-tall walls; door on south wall at
    (0,66,12)/(0,67,12). Bot at grass level (y=65 standing on y=64
    grass) south of the wall. Through must jump-nudge up + traverse."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill -2 65 9 1 65 12 minecraft:cobblestone",
        f"execute in {world} run fill -2 66 12 1 68 12 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 12 minecraft:air",
        f"execute in {world} run setblock 0 67 12 minecraft:air",
        f"execute in {world} run fill -2 66 9 -2 68 12 minecraft:cobblestone",
        f"execute in {world} run fill 1 66 9 1 68 12 minecraft:cobblestone",
        f"execute in {world} run fill -2 66 9 1 68 9 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 12 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {world} run setblock 0 67 12 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {world} run tp Tester 0 65 14 180 0",
    ])
    time.sleep(2.5)
    r = bot.post("/action/through", {"gx": 0, "gy": 66, "gz": 12}, timeout=20)
    # PASS if through succeeded OR the bot ended past the door (z<12).
    # The "crossed but didn't formally complete" outcome is still a
    # success for the F56 step-up contract — what we're verifying is
    # that the bot actually got over the lip.
    if r.get("ok"):
        return
    pos = bot.position()
    assert pos.get("z", 99) < 12.0, (
        f"through failed AND bot didn't cross: {r}, pos={pos}"
    )


@pytest.mark.functional
def test_through_flat_door_still_works(bot, rcon, config, elev_arena):
    """B: door at same y as bot, no step-up needed. Sanity check the
    F56 changes didn't break the simple case."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock -1 65 5 minecraft:cobblestone",
        f"execute in {world} run setblock -1 66 5 minecraft:cobblestone",
        f"execute in {world} run setblock 1 65 5 minecraft:cobblestone",
        f"execute in {world} run setblock 1 66 5 minecraft:cobblestone",
        f"execute in {world} run setblock 0 65 5 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {world} run setblock 0 66 5 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {world} run tp Tester 0 65 8 180 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/through", {"gx": 0, "gy": 65, "gz": 5}, timeout=15)
    if r.get("ok"):
        return
    pos = bot.position()
    assert pos.get("z", 99) < 5.0, f"through failed AND bot didn't cross: {r}, pos={pos}"
