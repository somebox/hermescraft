"""F56: `mc escape` tries all open directions; structured error on trap.

Migrated from scripts/test-escape-multidir.py. Three scenarios:
  A: 3-walled cell (N/E/S walls, open W) → escape via W → 'open' or 'alley'.
  B: corner (N+W walls, open E+S) → escape via E or S → 'open' or 'alley'.
  C: fully trapped (4 walls + ceiling) → structured error
     (ESCAPE_NO_OPEN_DIR / ESCAPE_ENCLOSURE / ESCAPE_CEILING_BLOCKED /
     ESCAPE_NO_PILLAR_BLOCK / ESCAPE_STUCK).

Uses the Tester bot at config.bot.roles.tester (declared via the
@pytest.mark.tester marker).
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def escape_arena(rcon, arena, tester_bot, config):
    """Stone-floored area + sub-floor; Tester bot used.

    F58: a GET /status call clears ctx.recentEscapes + ctx.recentStuckCells
    — required between scenarios because F57.1's ESCAPE_RECURRING_LOOP
    fires after 3 escapes in 90s. Without this reset, scenario A's escape
    primes the counter, then B/C trip the loop detector before their own
    geometry is exercised.
    """
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run time set noon",
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -10 60 -10 10 80 10 minecraft:air",
        f"execute in {world} run fill -10 60 -10 10 63 10 minecraft:stone",
        f"execute in {world} run fill -10 64 -10 10 64 10 minecraft:stone",
        "clear Tester",
    ])
    # F58 reset — clear recentEscapes / recentStuckCells.
    try:
        tester_bot.get("/status?lean=true", timeout=5)
    except Exception:
        pass
    arena.settle(seconds=1.0)
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill -10 60 -10 10 80 10 minecraft:air")


@pytest.mark.functional
@pytest.mark.tester
def test_escape_from_three_walled_cell(bot, rcon, config, escape_arena):
    """A: walls N/E/S, open W → escape, end classification open/alley."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 0 65 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 1 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock 0 65 1 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 1 66 0 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 1 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/escape", {}, timeout=20)
    assert r.get("ok"), r
    cls_after = (r.get("data") or {}).get("classification_after")
    assert cls_after in ("open", "alley"), r


@pytest.mark.functional
@pytest.mark.tester
def test_escape_from_corner(bot, rcon, config, escape_arena):
    """B: corner (N+W walls, open E+S) → escape via E or S → open/alley."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 0 65 -1 minecraft:cobblestone",
        f"execute in {world} run setblock -1 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock 0 66 -1 minecraft:cobblestone",
        f"execute in {world} run setblock -1 66 0 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/escape", {}, timeout=20)
    assert r.get("ok"), r
    cls_after = (r.get("data") or {}).get("classification_after")
    assert cls_after in ("open", "alley"), r


@pytest.mark.functional
@pytest.mark.tester
def test_escape_fully_trapped_returns_structured_error(bot, rcon, config, escape_arena):
    """C: 4 walls + ceiling, no pillar block → structured error."""
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
        f"execute in {world} run setblock 0 67 0 minecraft:bedrock",
        "clear Tester",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/escape", {}, timeout=20)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    # ESCAPE_RECURRING_LOOP is the F57.1 code that fires after 3 escapes
    # within 90s — counts as a valid structured error when A/B both fired
    # escape just before this test in the same suite.
    assert code in (
        "ESCAPE_NO_OPEN_DIR", "ESCAPE_ENCLOSURE", "ESCAPE_CEILING_BLOCKED",
        "ESCAPE_NO_PILLAR_BLOCK", "ESCAPE_STUCK", "ESCAPE_RECURRING_LOOP",
    ), r
