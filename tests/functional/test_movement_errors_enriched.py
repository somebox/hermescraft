"""F50.6: every movement error path carries observed_state.your_standing_state.

Migrated from scripts/test-movement-errors-enriched.py. Without F50.6 the
brain had to make an extra `mc observe` call after every move failure
to learn whether it was in a corner/wedge/etc. Now the error envelope
includes that info inline.

Scenarios:
  A: bot in alley (N+S walls, E+W open) + goto into solid →
     NAV_TARGET_OCCUPIED with classification=alley + blocked={N,S}.
  B: bot enclosed (no door) + move out → NAV_BLOCKED or BOT_TRAPPED
     with classification populated.
  C: bot fully trapped + goto → BOT_TRAPPED with classification=trapped.
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def movement_arena(rcon, arena, tester_bot, config):
    """Stone-floored area; Tester bot."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
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
    arena.settle_default()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.run(f"execute in {world} run fill -15 60 -15 15 80 15 minecraft:air")


@pytest.mark.functional
@pytest.mark.xfail(
    reason="Pollution-flaky in full suite (passes in isolation). Prior tests "
    "leave residual blocks/entities that affect this test's arena setup. "
    "Task #32. Pre-existing on mineflayer 4.35.0 and 4.37.1.",
    strict=False,
)
def test_goto_into_solid_in_alley_carries_standing_state(bot, rcon, config, movement_arena):
    """A: alley (N+S walls) + goto into a solid target → goto fails with
    your_standing_state.classification='alley' + blocked={N,S}.

    The regression target is the standing-state enrichment carrying
    correctly on movement failures. The error code is intentionally
    accepted as either NAV_TARGET_OCCUPIED (when Y-grace finds no
    standable cell within ±5) or NAV_BLOCKED (when Y-grace lifts the
    target to y+2 and the pathfinder then fails on the alley walls).
    On this flat stone floor Y-grace always succeeds → NAV_BLOCKED is
    the typical code; both are semantically correct.

    F51.1 silently pre-nudges out of corner/wedge/edge/three_walled, so
    we deliberately use ALLEY which is NOT sticky."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 0 65 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 0 65 1 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 1 minecraft:cobblestone",
        f"execute in {world} run setblock 5 65 5 minecraft:cobblestone",
        f"execute in {world} run setblock 5 66 5 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/goto", {"x": 5, "y": 65, "z": 5}, timeout=15)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    ss = obs.get("your_standing_state") or {}
    assert code in ("NAV_TARGET_OCCUPIED", "NAV_BLOCKED"), r
    assert ss.get("classification") == "alley", ss
    assert set(ss.get("blocked_dirs") or []) == {"N", "S"}, ss


@pytest.mark.functional
def test_move_inside_walled_box_carries_standing_state(bot, rcon, config, movement_arena):
    """B: bot in 3×3 walled box + move out → NAV_BLOCKED or BOT_TRAPPED
    with classification populated."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill -2 65 -2 2 66 -2 minecraft:cobblestone",
        f"execute in {world} run fill -2 65 2 2 66 2 minecraft:cobblestone",
        f"execute in {world} run fill -2 65 -2 -2 66 2 minecraft:cobblestone",
        f"execute in {world} run fill 2 65 -2 2 66 2 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/move", {"x": 5, "y": 65, "z": 5}, timeout=20)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    ss = obs.get("your_standing_state") or {}
    assert code in ("NAV_BLOCKED", "BOT_TRAPPED"), r
    assert ss.get("classification"), ss


@pytest.mark.functional
def test_trapped_bot_carries_trapped_standing_state(bot, rcon, config, movement_arena):
    """C: bot trapped on all 4 sides + goto → BOT_TRAPPED with
    your_standing_state.classification='trapped'."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 0 65 -1 minecraft:bedrock",
        f"execute in {world} run setblock 1 65 0 minecraft:bedrock",
        f"execute in {world} run setblock 0 65 1 minecraft:bedrock",
        f"execute in {world} run setblock -1 65 0 minecraft:bedrock",
        f"execute in {world} run setblock 0 66 -1 minecraft:bedrock",
        f"execute in {world} run setblock 1 66 0 minecraft:bedrock",
        f"execute in {world} run setblock 0 66 1 minecraft:bedrock",
        f"execute in {world} run setblock -1 66 0 minecraft:bedrock",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/goto", {"x": 5, "y": 65, "z": 5}, timeout=15)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    ss = obs.get("your_standing_state") or {}
    assert code == "BOT_TRAPPED", r
    assert ss.get("classification") == "trapped", ss
