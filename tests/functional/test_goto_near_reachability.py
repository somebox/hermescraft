"""F73: `mc goto_near` surfaces walkable_to_target + next_hop_suggestion.

Migrated from scripts/test-goto-near-reachability.py. When the
pathfinder's GoalNear lands the bot at a cell within `range` of the
target but on the wrong side of a wall, the response carries
`walkable_to_target: false` and a `next_hop_suggestion` cell the bot
CAN reach. F73 is the success-side companion to F74 (failure side,
migrated as test_stall_reachability).

Scenarios:
  A: bot north of wall, target south, `range=2` → goto_near "succeeds"
     (in the sense that the bot is within range) but the path to the
     target itself is blocked → walkable_to_target=false + next_hop set.
  B: open arena, target directly reachable → walkable_to_target=true,
     no next_hop_suggestion.
"""

from __future__ import annotations

import math
import pytest


@pytest.fixture
def reachability_arena(rcon, arena, config, functional_world):
    """Per-test props only; harness already reset grass and park at origin."""
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    yield
    arena.forceload_remove_all()


def _observed_state(response: dict) -> dict:
    """F73 puts observed_state at top-level on success, inside data on others."""
    return response.get("observed_state") or (response.get("data") or {}).get("observed_state") or {}


@pytest.mark.functional
def test_unreachable_target_surfaces_walkable_false_and_next_hop(bot, rcon, arena, config, reachability_arena):
    """A: wall at z=1 between bot (z=-1) and target (z=2) — bot lands near
    but can't actually reach. walkable_to_target=false + next_hop_suggestion."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill -3 65 1 3 66 1 minecraft:obsidian",
        "clear Tester",
        f"execute in {world} run tp Tester 0 65 -1 0 0",
    ])
    arena.settle_fast()
    try:
        bot.post("/action/stop", {}, timeout=3.0)
    except Exception:
        pass
    r = bot.post("/action/goto_near", {"x": 0, "y": 65, "z": 2, "range": 2}, timeout=25)
    assert r.get("ok"), f"expected GoalNear success within range=2: {r}"
    pos = bot.position()
    dist = math.hypot(pos.get("x", 0) - 0, pos.get("z", 0) - 2)
    assert dist <= 2.5, f"bot not within range of target: pos={pos}, dist={dist}"
    obs = _observed_state(r)
    assert obs.get("walkable_to_target") is False, r
    assert obs.get("next_hop_suggestion") is not None, obs


@pytest.mark.functional
def test_reachable_target_reports_walkable_true(bot, rcon, arena, config, reachability_arena):
    """B: open arena, target at (5,65,5) — walkable_to_target=true and no
    next_hop_suggestion (F73 only emits the hint when navigation is blocked)."""
    world = config["mc"]["world"]
    rcon.batch([
        "clear Tester",
        f"execute in {world} run tp Tester 0 65 0 0 0",
    ])
    arena.settle_fast()
    try:
        bot.post("/action/stop", {}, timeout=3.0)
    except Exception:
        pass
    r = bot.post("/action/goto_near", {"x": 5, "y": 65, "z": 5, "range": 1}, timeout=25)
    assert r.get("ok"), r
    pos = bot.position()
    dist = math.hypot(pos.get("x", 0) - 5, pos.get("z", 0) - 5)
    assert dist <= 1.5, f"bot not within range=1 of target: pos={pos}"
    obs = _observed_state(r)
    assert obs.get("walkable_to_target") is True, r
    assert obs.get("next_hop_suggestion") is None, obs
