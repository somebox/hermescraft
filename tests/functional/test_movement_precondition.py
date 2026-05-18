"""F51.2: a failed move taints subsequent position-dependent verbs nearby.

Migrated from scripts/test-movement-precondition.py. After a failed
goto/move/goto_near, the bot is NOT where the brain thinks. The next
position-dependent verb (interact/place/deposit/...) targeting within
5 blocks of the failed move's intended target is intercepted with
MOVEMENT_PRECONDITION_FAILED. The flag clears on `mc status`, a
successful move, or 30s age-out.

Scenarios:
  A: failed goto + interact near same coord → MOVEMENT_PRECONDITION_FAILED.
  B: same setup + mc status between → flag cleared, interact NOT
     intercepted.
  C: failed goto + interact >5 blocks away → not intercepted (proximity
     guard is real, not blanket-on).

Care: scenario B uses an INDEPENDENT failed-move trigger because A's
own MOVEMENT_PRECONDITION_FAILED doesn't itself touch lastMoveFailed —
the flag stays set across A → B unless `mc status` clears it. The
function-scoped fixture clears it before each test.
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


def _seal_target(rcon, world: str) -> None:
    """3-tall cobble box around (5,65,5) — pathfinder can't reach it."""
    walls = []
    for y in (65, 66, 67):
        for (x, z) in [(5, 4), (5, 6), (4, 5), (6, 5)]:
            walls.append(f"execute in {world} run setblock {x} {y} {z} minecraft:cobblestone")
    walls.append(f"execute in {world} run setblock 5 68 5 minecraft:cobblestone")
    rcon.batch(walls)


def _trigger_failed_move(bot) -> dict:
    """Run a goto guaranteed to fail INSIDE the pathfinder so
    lastMoveFailed is recorded. NAV_TARGET_OCCUPIED is a pre-check that
    doesn't attempt motion; we want pathfinder_error / NAV_BLOCKED."""
    return bot.post("/action/goto", {"x": 5, "y": 65, "z": 5}, timeout=15)


@pytest.fixture
def precondition_arena(rcon, arena, tester_bot, config):
    """Stone-floored area; Tester. F58 reset clears any lingering
    lastMoveFailed / recentEscapes from prior tests."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -15 60 -15 15 80 15 minecraft:air",
        f"execute in {world} run fill -15 60 -15 15 63 15 minecraft:stone",
        f"execute in {world} run fill -15 64 -15 15 64 15 minecraft:stone",
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
def test_failed_move_taints_nearby_interact(bot, rcon, config, precondition_arena):
    """A: failed goto + interact at (8,65,5) → MOVEMENT_PRECONDITION_FAILED."""
    world = config["mc"]["world"]
    _seal_target(rcon, world)
    rcon.batch([
        f"execute in {world} run setblock 8 65 5 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {world} run setblock 8 66 5 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    g = _trigger_failed_move(bot)
    assert not g.get("ok"), f"goto unexpectedly succeeded: {g}"
    r = bot.post("/action/interact", {"x": 8, "y": 65, "z": 5}, timeout=10)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "MOVEMENT_PRECONDITION_FAILED", r


@pytest.mark.functional
def test_status_clears_precondition_flag(bot, rcon, tester_bot, config, precondition_arena):
    """B: failed goto + mc status + interact → precondition NOT raised
    (status acknowledged the failed move)."""
    world = config["mc"]["world"]
    _seal_target(rcon, world)
    rcon.batch([
        f"execute in {world} run setblock 8 65 5 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {world} run setblock 8 66 5 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    g = _trigger_failed_move(bot)
    assert not g.get("ok"), f"goto unexpectedly succeeded: {g}"
    # mc status clears the F51.2 flag (and F58 escape state).
    s = tester_bot.get("/status?lean=true", timeout=5)
    assert s.get("ok"), s
    r = bot.post("/action/interact", {"x": 8, "y": 65, "z": 5}, timeout=15)
    code, _, _ = extract_error(r)
    assert code != "MOVEMENT_PRECONDITION_FAILED", r


@pytest.mark.functional
def test_far_target_not_intercepted(bot, rcon, config, precondition_arena):
    """C: failed goto + interact >5 blocks away → guard does NOT fire."""
    world = config["mc"]["world"]
    _seal_target(rcon, world)
    rcon.batch([
        f"execute in {world} run setblock -12 65 -12 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {world} run setblock -12 66 -12 minecraft:oak_door[half=upper,facing=south]",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    g = _trigger_failed_move(bot)
    assert not g.get("ok"), f"goto unexpectedly succeeded: {g}"
    r = bot.post("/action/interact", {"x": -12, "y": 65, "z": -12}, timeout=15)
    code, _, _ = extract_error(r)
    # The verb itself may fail (OUT_OF_RANGE) — we only assert the
    # precondition guard didn't fire.
    assert code != "MOVEMENT_PRECONDITION_FAILED", r
