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

import pytest


@pytest.fixture
def reachability_arena(rcon, arena, tester_bot, config):
    """Flat 21×21 grass-floored area, forceload chunks, peaceful mode.
    Each test sets its own walls + starts Tester at its own coord."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule keepInventory true",
        # Cross-dim safe — if bot is elsewhere, bring it home first.
        f"execute as Tester at @s in {world} run tp @s 0 65 0",
    ])
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="grass_block")
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="grass_block")
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
    arena.settle()
    r = bot.post("/action/goto_near", {"x": 0, "y": 65, "z": 2, "range": 2}, timeout=30)
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
    arena.settle()
    r = bot.post("/action/goto_near", {"x": 5, "y": 65, "z": 5, "range": 1}, timeout=30)
    obs = _observed_state(r)
    assert obs.get("walkable_to_target") is True, r
    assert obs.get("next_hop_suggestion") is None, obs
