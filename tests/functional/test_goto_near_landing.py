"""F50.5: `goto_near` reports landing classification + suggested_correction.

Migrated from scripts/test-goto-near-landing.py. goto_near lands the
bot at SOME cell within `range` — often a fractional position next to
a wall (Mason in G21 v2 routinely ended up in wedge/corner). F50.5 has
goto_near scan for a cleaner candidate inside `range` and report it
via observed_state.suggested_correction so the brain can mc move there.

Scenarios:
  A: target inside a 3-wall pocket → landed_in in {corner, wedge, edge,
     three_walled}, suggested_correction surfaced.
  B: open arena → clean landing, no landed_in field.
"""

from __future__ import annotations

import time

import pytest


@pytest.fixture
def landing_arena(rcon, arena, tester_bot, config):
    """Stone-floored area + sub-floor; Tester bot."""
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


@pytest.mark.functional
@pytest.mark.tester
def test_landing_in_three_walled_pocket_reports_classification(bot, rcon, config, landing_arena):
    """A: 3-wall pocket around target (5,65,0); range=0 forces bot to
    stand on the target cell itself. landed_in must surface a sticky
    classification."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 5 65 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 5 66 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 6 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock 6 66 0 minecraft:cobblestone",
        f"execute in {world} run setblock 5 65 1 minecraft:cobblestone",
        f"execute in {world} run setblock 5 66 1 minecraft:cobblestone",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    time.sleep(2.0)
    r = bot.post("/action/goto_near", {"x": 5, "y": 65, "z": 0, "range": 0}, timeout=20)
    assert r.get("ok"), r
    obs = r.get("observed_state") or {}
    landed_in = obs.get("landed_in")
    assert landed_in in {"corner", "wedge", "edge", "three_walled"}, obs


@pytest.mark.functional
@pytest.mark.tester
def test_clean_landing_in_open_arena_has_no_landed_in(bot, rcon, config, landing_arena):
    """B: no walls; landed_in must be absent (clean success path)."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    time.sleep(2.0)
    r = bot.post("/action/goto_near", {"x": 5, "y": 65, "z": 0, "range": 2}, timeout=20)
    assert r.get("ok"), r
    obs = r.get("observed_state") or {}
    assert obs.get("landed_in") is None, obs
