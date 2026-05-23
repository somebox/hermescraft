"""Reactive layer protects the bot from drowning.

Migrated from scripts/test-drown-protection.py. The reactive layer
runs `swim_up` whenever `in_water && oxygen <= 14` — analogous to fire
protection. Even when the pathfinder is actively dragging the bot
underwater, swim_up must override and surface the bot before HP drops.

Scenarios:
  A: drop bot at (0,61,0) inside a 4-deep water column with open
     surface — bot must reach y>=64 within 12s with HP>=15.
  B: same setup + a goto goal that drives the bot under water — the
     reactive layer's pathfinder-cancel must still surface the bot.
"""

from __future__ import annotations

import time

import pytest


@pytest.fixture
def pool_arena(rcon, arena, tester_bot, config):
    """3×3 water column on canonical surface; grass cap around the pool.
    Bot starts NOT in the water — each test TPs it underwater explicitly."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill -2 64 -2 2 64 2 minecraft:stone",
        f"execute in {world} run fill -1 61 -1 1 64 1 minecraft:water",
        f"execute in {world} run fill -6 64 -6 -2 64 6 minecraft:grass_block",
        f"execute in {world} run fill 2 64 -6 6 64 6 minecraft:grass_block",
        f"execute in {world} run fill -1 64 -6 1 64 -2 minecraft:grass_block",
        f"execute in {world} run fill -1 64 2 1 64 6 minecraft:grass_block",
    ])
    arena.settle_water()
    yield


def _tp_underwater(arena, bot, world: str) -> None:
    """Place Tester at (0,61,0) underwater, clear inventory, give long
    saturation. arena.place_player wraps tp + wait_until_stationary;
    water bobbing settles within the 0.4s stable window."""
    arena.rcon.batch([
        f"clear Tester",
        f"execute in {world} run effect clear Tester",
        f"execute in {world} run effect give Tester minecraft:saturation 600 1",
    ])
    arena.place_player(bot, 0, 61, 0)


def _wait_for_surface(bot, max_seconds: int = 12) -> tuple[bool, float]:
    """Poll status every 1s until y>=64 OR deadline. Returns (surfaced, final_hp)."""
    final_hp = 20.0
    for _ in range(max_seconds):
        time.sleep(1.0)
        s = bot.status_lean()
        pos = s.get("position") or {}
        final_hp = s.get("health", 20)
        if pos.get("y", 0) >= 64:
            return True, final_hp
    return False, final_hp


@pytest.mark.functional
def test_reactive_layer_surfaces_bot_within_12s(bot, rcon, arena, config, pool_arena):
    """A: bot underwater, no pathfinder goal — reactive swim_up surfaces
    within 12s with HP>=15."""
    world = config["mc"]["world"]
    _tp_underwater(arena, bot, world)
    bot.post("/action/mode", {"name": "normal"}, timeout=5)
    surfaced, hp = _wait_for_surface(bot, max_seconds=12)
    assert surfaced, f"bot did not reach y>=64 in 12s; final hp={hp}"
    assert hp >= 15, f"bot surfaced but HP={hp} < 15"


@pytest.mark.functional
def test_swim_up_overrides_pathfinder_underwater(bot, rcon, arena, config, pool_arena):
    """B: bot underwater + a goto goal that would drag it deeper. swim_up
    must cancel the pathfind and surface the bot. HP threshold is looser
    (>=12) because the goto attempt may eat a few oxygen ticks before
    cancellation."""
    world = config["mc"]["world"]
    _tp_underwater(arena, bot, world)
    bot.post("/action/mode", {"name": "normal"}, timeout=5)
    # Background goto — fire-and-forget. If bg_goto doesn't exist,
    # fall back to a short blocking goto (3s timeout).
    try:
        bot.post("/action/bg_goto", {"x": 0, "y": 61, "z": -5}, timeout=3)
    except Exception:
        try:
            bot.post("/action/goto", {"x": 0, "y": 61, "z": -5}, timeout=3)
        except Exception:
            pass
    surfaced, hp = _wait_for_surface(bot, max_seconds=15)
    assert surfaced, f"bot didn't surface within 15s with active pathfind; hp={hp}"
    assert hp >= 12, f"bot surfaced but HP={hp} < 12 — swim_up didn't cancel pathfind fast enough"
