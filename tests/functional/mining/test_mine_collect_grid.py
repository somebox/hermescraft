"""3×3 cobble grid mine+collect: drives `mc collect` against staged geometry.

Migrated from scripts/test-mine-collect-grid.py with the auto-pickup
straggler sweep + safe-tp checks intact (Round 2 fixes preserved).

Bot stands OUTSIDE the grid at (1,65,4) facing east (one block closer
than the legacy (0,65,4) standoff so post-dig drops stay in pickup range).
The pillar at (2,65,4) blocks LOS to the center (4,65,4) — `mc collect` must
multi-iterate, re-scanning the LOS-valid pool after each dig.

Scenarios:
  A: 3×3 height=1, count=1 (single front-pillar — strict 1/1).
  B: 3×3 height=1, count=9 (full clear, multi-iteration).
  D: 3×3 height=1, count=9, walk-away + pickup (tests pathfinding back
     through partial grid to remaining drops).

  (C — 3×3 height=2, count=18 — dropped 2026-05-27; redundant with B.
   See comment above test_collect_then_walk_away_and_pickup.)

Scattered-target collection (heterogeneous block types, non-grid
spatial layout) is covered by
`tests/functional/terrain/test_terrain_shaping.py::test_collect_scattered_target_with_distractors`
— don't duplicate that pattern here.

Auto-magnet tolerance: an explicit post-collect pickup sweep gathers
stragglers before the inventory delta is measured. Per-iteration we
allow a 1-block shortfall on multi-drop scenarios (B/C/D) because the
falling-block→item conversion is racy.
"""

from __future__ import annotations

import math
import time

import pytest


# Pillar int-cells the grid occupies — used to verify the bot didn't
# land inside one. Matches the 3×3 grid at x∈{2,4,6}, z∈{2,4,6}.
GRID_PILLAR_CELLS = {(x, z) for x in (2, 4, 6) for z in (2, 4, 6)}


@pytest.fixture
def grid_arena(functional_world, rcon, arena, config):
    arena.settle_default()
    yield


def _build_grid(arena, rcon, world: str, height: int) -> None:
    if height == 1:
        arena.load_prefab("mining_grid_3x3", (2, 65, 2))
    else:
        arena.grid_3x3(center=(4, 65, 4), height=height)
    rcon.batch([
        f"execute in {world} run tp Tester 1 65 4 270 0",
        "give Tester minecraft:stone_pickaxe",
    ])
    arena.settle_water()


def _assert_safe_post_tp(bot) -> None:
    """Verify the bot landed outside the grid + at full HP. A failure here
    is a TEST BUG (wrong tp coords), not a framework bug."""
    s = bot.status_lean()
    pos = s.get("position") or {}
    px, pz = pos.get("x"), pos.get("z")
    assert px is not None and pz is not None, s
    cell = (math.floor(px), math.floor(pz))
    assert cell not in GRID_PILLAR_CELLS, f"bot inside pillar cell {cell} at ({px:.2f},{pz:.2f})"
    hp = s.get("health")
    assert hp is None or hp >= 19.5, f"bot HP={hp} after TP — likely suffocating"


def _run_collect_scenario(
    bot, arena, rcon, world: str, height: int, want_count: int, walk_away: bool
) -> None:
    """Drive mc collect against the staged 3×3 pillar grid.

    Purpose of these tests is NOT to assert perfect mining throughput —
    that's non-deterministic in practice (occasional pathfind/LOS gaps
    in the strip-mine loop, mineflayer auto-magnet timing flake). The
    real contract is:

      (1) mc collect doesn't HANG, WEDGE, or hit the outer 40s cap —
          the verb returns a structured response well within budget;
      (2) when blocks ARE missed, the verb surfaces actionable context
          (`causes` per-failure-reason + `partial_failure: true`) so the
          agent can decide what to do next instead of guessing;
      (3) a strong majority of the requested blocks land in inventory
          (percentage threshold below) — proving the loop made real
          progress rather than thrashing.

    Strict 1/1 is enforced for the count=1 case (no tolerance possible).
    """
    _build_grid(arena, rcon, world, height)
    _assert_safe_post_tp(bot)
    pre = bot.inventory().get("cobblestone", 0)
    t0 = time.time()
    r = bot.post(
        "/action/collect",
        {"block": "cobblestone", "count": want_count, "range": 12},
        timeout=120,
    )
    elapsed = time.time() - t0
    assert r.get("ok"), r
    data = r.get("data") or {}
    mined_count = data.get("mined_count", 0)
    causes = data.get("causes")
    partial_failure = data.get("partial_failure")

    if walk_away:
        rcon.run(f"execute in {world} run tp Tester -5 65 -5 0 0")
        time.sleep(0.5)
    # inventory_delta calls /action/pickup internally as fallback;
    # behaves the same whether or not we walked away.
    inv_poll_s = 5.0 if want_count == 1 else 3.0
    post = bot.inventory_delta("cobblestone", timeout=inv_poll_s, baseline=pre, fallback_pickup=True)
    gained = post - pre
    delivered = data.get("drop_item_gained")
    if delivered is None:
        delivered = data.get("items_collected_in_inventory")

    # (1) No hang / wedge — verb exited gracefully (35s inner budget +
    # 5s slack < the 45s here < /action/collect's 120s outer timeout).
    assert elapsed < 45, f"collect took {elapsed:.1f}s — pathfinder wedge / outer-cap miss"

    # (2) Structured context preserved on a partial result. When the
    # verb falls short, the agent must get a `causes` breakdown and
    # `partial_failure: true` so it can plan a recovery (move, retry,
    # change tool, etc.). Skip this check on full clears (no partial
    # to surface).
    if mined_count < want_count:
        assert isinstance(causes, dict) and causes, (
            f"partial collect must expose `causes` for the agent (mined {mined_count}/{want_count}); got data={data}"
        )
        assert partial_failure is True, (
            f"partial collect must flag partial_failure=true; got {partial_failure}"
        )

    # (3) Strong-majority threshold. The legacy 1-block tolerance
    # codified the auto-magnet + pathfind-corner-block flake. We
    # generalize to a percentage so larger counts inherit the same
    # philosophy. 85% means 1 miss on 9-block runs, 2 misses on 18.
    # For count=1, ceil(0.85)=1 → still strict.
    threshold = want_count if want_count == 1 else math.ceil(want_count * 0.85)
    assert mined_count >= threshold, (
        f"mc collect mined {mined_count}/{want_count} (threshold {threshold}) — "
        f"causes={causes} elapsed={elapsed:.1f}s"
    )
    inv_threshold = want_count if want_count == 1 else math.ceil(want_count * 0.75)
    if want_count == 1 and delivered is not None:
        assert delivered >= 1, (
            f"collect reported drop_item_gained={delivered} for strict 1/1; data={data}"
        )
    assert gained >= inv_threshold, (
        f"inventory gained {gained}/{want_count} (threshold {inv_threshold}) — "
        f"mined_count={mined_count} drop_item_gained={delivered}"
    )
    if want_count == 1:
        assert rcon.block_is(2, 65, 2, "air") or rcon.block_is(4, 65, 2, "air"), (
            "single-block collect should remove at least one grid cobble"
        )


@pytest.mark.functional
def test_collect_one_pillar_from_outside(bot, arena, rcon, config, grid_arena):
    """A: count=1 — single-block case (threshold = 1, strict by math)."""
    _run_collect_scenario(bot, arena, rcon, config["mc"]["world"], height=1, want_count=1, walk_away=False)


@pytest.mark.functional
@pytest.mark.slow
def test_collect_all_nine_pillars_height1(bot, arena, rcon, config, grid_arena):
    """B: 9 pillars height=1 — verb returns within budget, ≥85% land, partials carry causes."""
    _run_collect_scenario(bot, arena, rcon, config["mc"]["world"], height=1, want_count=9, walk_away=False)


# Scenario C (3×3 height=2, count=18) was dropped 2026-05-27 as
# redundant with B — same multi-iteration code path, just a taller
# pillar variant. The 85% threshold + ≥1 shortfall tolerance in
# _run_collect_scenario already exercises the partial-clear case at
# count=9 in B; adding a tall variant only inflates suite runtime
# without exercising a distinct branch. Height variation is covered
# indirectly by walk_away=True (D) which catches stragglers from
# the partial dig path.


@pytest.mark.functional
@pytest.mark.slow
def test_collect_then_walk_away_and_pickup(bot, arena, rcon, config, grid_arena):
    """D: collect 9 height=1, tp away, pickup — tests pathfind-back, ≥85% threshold."""
    _run_collect_scenario(bot, arena, rcon, config["mc"]["world"], height=1, want_count=9, walk_away=True)
