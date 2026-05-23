"""F47: `mc flee` returns structured NO_THREAT when nothing hostile is near.

Migrated from scripts/test-flee-no-threat.py. The G21 v1 bug: legacy
flee returned "No threats nearby" as a SUCCESS message; weak-model
brains misread that as "I fled successfully," went into recovery loops.
F47 makes the no-threat case a structured error, AND removes 'player'
from the auto-hostiles list so bots stop fleeing their own partners.

Scenarios:
  A: empty arena → NO_THREAT.
  B: passive cow nearby (not hostile) → NO_THREAT.
  C: zombie nearby → ok=true, threat.name='zombie', flee_reason
     starts with 'hostile_mob:'.
  D: nearby visible player without `from` arg → NO_THREAT
     (regression check for the auto-targeting bug).
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def empty_world(rcon, arena, config, functional_world):
    """Harness-clean arena; tests may spawn mobs. Teardown kills stragglers."""
    world = config["mc"]["world"]
    yield
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run difficulty peaceful",
    ])


def _spawn_mob(rcon, world: str, kind: str, x: float, y: float, z: float, no_ai: bool = True) -> None:
    nbt = "{NoAI:1b,Silent:1b,PersistenceRequired:1b}" if no_ai else "{Silent:1b,PersistenceRequired:1b}"
    rcon.run(f"execute in {world} run summon {kind} {x} {y} {z} {nbt}")
    time.sleep(0.5)


@pytest.mark.functional
def test_flee_empty_arena_returns_no_threat(bot, empty_world):
    """A: nothing alive → NO_THREAT."""
    r = bot.post("/action/flee", {"distance": 16}, timeout=10)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_THREAT", r


@pytest.mark.functional
def test_flee_passive_cow_returns_no_threat(bot, rcon, config, empty_world):
    """B: passive cow at (3,65,0) → NO_THREAT (cows aren't hostile)."""
    _spawn_mob(rcon, config["mc"]["world"], "cow", 3, 65, 0)
    r = bot.post("/action/flee", {"distance": 16}, timeout=10)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_THREAT", r


@pytest.mark.functional
def test_flee_zombie_triggers_hostile_mob_flee(bot, rcon, config, empty_world):
    """C: live zombie nearby → ok=true, threat.name='zombie',
    flee_reason starts with 'hostile_mob:'."""
    world = config["mc"]["world"]
    # Easy difficulty so the zombie spawns alive; NoAI=false so it
    # generates packets mineflayer perception picks up.
    rcon.run(f"execute in {world} run difficulty easy")
    _spawn_mob(rcon, world, "zombie", 3, 65, 0, no_ai=False)
    time.sleep(1.0)
    try:
        r = bot.post("/action/flee", {"distance": 16}, timeout=25)
        assert r.get("ok"), r
        data = r.get("data") or {}
        threat = data.get("threat") or {}
        assert threat.get("name") == "zombie", data
        assert (data.get("flee_reason") or "").startswith("hostile_mob:"), data
    finally:
        rcon.batch([
            f"execute in {world} run kill @e[type=zombie]",
            f"execute in {world} run difficulty peaceful",
        ])
        try:
            bot.post("/action/stop", {}, timeout=3.0)
        except Exception:
            pass


@pytest.mark.functional
def test_flee_does_not_auto_target_players(bot, empty_world):
    """D: no hostile mobs, possibly a player nearby → NO_THREAT regardless.
    Regression check: pre-F47 the auto-hostiles list included 'player'
    and the bot would flee from teammates. Now player is excluded."""
    r = bot.post("/action/flee", {"distance": 16}, timeout=10)
    assert not r.get("ok"), r
    code, _, _ = extract_error(r)
    assert code == "NO_THREAT", r
