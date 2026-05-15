"""F74: pathfinder failure responses surface walkable_to_target + next_hop_suggestion.

Migrated from scripts/test-stall-reachability.py. Companion to F73,
which adds the same fields on a SUCCESSFUL goto_near. When the
pathfinder gives up (NAV_BLOCKED) or stalls (NAV_NO_PROGRESS), the
error envelope must carry a BFS reachability hint so the agent brain
can route around the obstacle rather than looping `mc escape` / `mc dig`.

Scenario: bot is fully penned by a 5×5 obsidian box (4 tall, no jump-out);
target is outside. Pathfinder cannot find a path. Error code is NAV_BLOCKED
or NAV_NO_PROGRESS — both are acceptable (race between A* and watchdog).
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def boxed_in_bot(rcon, arena, flint_bot, config):
    """Build the pen BEFORE teleporting Flint in — if the bot is cross-dim
    from a previous test, the first tp lands in the target dim and the
    floor must exist or the bot drops into the void."""
    world = config["mc"]["world"]
    flint_bot.wait_until_ready(timeout=10)
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule keepInventory true",
    ])
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="grass_block")
    rcon.batch([
        # 5×5 obsidian shell at y=65..68 (4 tall — no jumping out).
        f"execute in {world} run fill -2 65 -2 2 68 2 minecraft:obsidian",
        # Carve a 3×3×4 inner cell.
        f"execute in {world} run fill -1 65 -1 1 68 1 minecraft:air",
        "clear Flint",
        # Cross-dim safe form: `execute as Flint at @s in <world>` resolves
        # selectors in Flint's current dim then teleports him into <world>.
        f"execute as Flint at @s in {world} run tp @s 0.5 65 0.5 0 0",
    ])
    arena.settle(seconds=3.0)  # extra settle — the pen build is substantial
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="grass_block")
    arena.forceload_remove_all()


@pytest.mark.functional
def test_nav_failure_carries_walkable_and_next_hop(bot, boxed_in_bot):
    """Bot boxed in, target at (5,65,5) outside the pen — goto_near fails
    with NAV_BLOCKED or NAV_NO_PROGRESS and observed_state carries both
    walkable_to_target=false and a next_hop_suggestion (anywhere — F74
    just guarantees presence, not optimal direction)."""
    r = bot.post("/action/goto_near", {"x": 5, "y": 65, "z": 5, "range": 1}, timeout=45)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code in {"NAV_BLOCKED", "NAV_NO_PROGRESS"}, r
    assert obs.get("walkable_to_target") is False, obs
    assert obs.get("next_hop_suggestion") is not None, obs
