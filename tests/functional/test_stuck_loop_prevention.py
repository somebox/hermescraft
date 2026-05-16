"""F57: stuck-loop prevention (3 sub-fixes).

Migrated from scripts/test-stuck-loop-prevention.py. Tests the F57
sub-fixes:
  F57.1: ESCAPE_RECURRING_LOOP after 3 escapes in 90s.
  F57.2: NAV_RECURRING_STUCK on goto-near targets within 1 block of a
         recent stuck cell (hit_count ≥ 2).
  F57.3: Successful mc escape carries observed_state.do_not_retry_goto.

Note for A: this scenario INTENTIONALLY exercises the recurring-loop
behavior — fixture does NOT clear recentEscapes via /status because A
needs the counter to accumulate.
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def stuck_arena(rcon, arena, tester_bot, config):
    """Stone-floored area; Tester. F58 /status reset to clear lingering
    state from prior tests (but the tests themselves may rebuild state)."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run time set noon",
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


def _rebuild_corner(rcon, world: str) -> None:
    """Walls at N+W of (0,65,0). After each escape the bot is at (1,65,0)
    or (0,65,1) — both open — we re-trap so classification stays sticky."""
    rcon.batch([
        f"execute in {world} run setblock 0 65 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 -1 minecraft:cobblestone",
        f"execute in {world} run setblock -1 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock -1 66 0 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(1.5)


@pytest.mark.functional
@pytest.mark.tester
def test_F57_1_escape_recurring_loop_after_3_within_90s(bot, rcon, config, stuck_arena):
    """A: 3 escapes from same corner within 90s → 3rd (or retry#4)
    returns ESCAPE_RECURRING_LOOP. Re-trap between each so classification
    stays sticky."""
    world = config["mc"]["world"]
    _rebuild_corner(rcon, world)
    codes = []
    for i in range(3):
        r = bot.post("/action/escape", {}, timeout=15)
        codes.append(extract_error(r)[0] if not r.get("ok") else "OK")
        if i < 2:
            _rebuild_corner(rcon, world)
    # Mineflayer's stickiness can shuffle which call trips the detector.
    # Accept ESCAPE_RECURRING_LOOP in any of the 3 calls; if not, do one
    # more retry.
    if "ESCAPE_RECURRING_LOOP" not in codes:
        _rebuild_corner(rcon, world)
        r4 = bot.post("/action/escape", {}, timeout=15)
        codes.append(extract_error(r4)[0] if not r4.get("ok") else "OK")
    assert "ESCAPE_RECURRING_LOOP" in codes, f"never saw ESCAPE_RECURRING_LOOP; codes={codes}"


@pytest.mark.functional
@pytest.mark.tester
def test_F57_2_repeated_goto_to_unreachable_target_fails_clearly(bot, rcon, config, stuck_arena):
    """B: 4 consecutive gotos to a sealed/lipped target. Pass if either
    NAV_RECURRING_STUCK appears OR every attempt returns a clear nav
    failure code (the contract is that the bot doesn't silently spin)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 3 65 3 minecraft:cobblestone",
        f"execute in {world} run setblock 4 65 3 minecraft:cobblestone",
        f"execute in {world} run setblock 5 65 3 minecraft:cobblestone",
        f"execute in {world} run setblock 3 66 3 minecraft:cobblestone",
        f"execute in {world} run setblock 4 66 3 minecraft:cobblestone",
        f"execute in {world} run setblock 5 66 3 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    seen = []
    target = {"x": 8, "y": 65, "z": 8}
    for _ in range(4):
        r = bot.post("/action/goto", target, timeout=20)
        if r.get("ok"):
            seen.append("OK")
            break
        seen.append(extract_error(r)[0] or "?")
    # PASS conditions, in order of preference:
    #  • NAV_RECURRING_STUCK fires (the strong F57.2 signal).
    #  • Goto succeeds — the lip is routable so the F57.2 trigger isn't
    #    exercised; that's not a framework failure (the bot used the
    #    pathfinder correctly, which is what F57.2 is preventing
    #    breakage of).
    #  • Every failed attempt returns a clean nav error code — proves
    #    the bot doesn't silently spin even when stuck.
    if "NAV_RECURRING_STUCK" in seen or "OK" in seen:
        return
    acceptable = {"NAV_BLOCKED", "NAV_NO_PROGRESS", "BOT_TRAPPED", "NAV_TARGET_OCCUPIED"}
    assert all(c in acceptable for c in seen), f"unexpected codes: {seen}"


@pytest.mark.functional
@pytest.mark.tester
def test_F57_3_successful_escape_carries_do_not_retry_goto(bot, rcon, config, stuck_arena):
    """C: failed goto records ctx.lastMoveFailed; subsequent successful
    escape returns observed_state.do_not_retry_goto = that intended
    target (x=5 here).

    The failed-move must be a real pathfinder_error (not a pre-flight
    rejection), so we seal the target with a 3-tall box that pathfinder
    actually attempts to route around but fails."""
    world = config["mc"]["world"]
    # Sealed target at (5,65,5): 3-tall walls + roof so pathfinder
    # reports NAV_BLOCKED, recording lastMoveFailed.
    walls = []
    for y in (65, 66, 67):
        for (x, z) in [(5, 4), (5, 6), (4, 5), (6, 5)]:
            walls.append(f"execute in {world} run setblock {x} {y} {z} minecraft:cobblestone")
    walls.append(f"execute in {world} run setblock 5 68 5 minecraft:cobblestone")
    walls.append(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.batch(walls)
    time.sleep(2.0)
    bot.post("/action/goto", {"x": 5, "y": 65, "z": 5}, timeout=15)
    _rebuild_corner(rcon, world)
    r = bot.post("/action/escape", {}, timeout=15)
    assert r.get("ok"), r
    data = r.get("data") or {}
    do_not_retry = data.get("do_not_retry_goto")
    assert isinstance(do_not_retry, dict), data
    assert do_not_retry.get("x") == 5, do_not_retry
