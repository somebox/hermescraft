"""Water-navigation arena tests — live regression coverage for the
v25→v37 sail_to fix-pass.

Status: framework in place, all three tests currently @xfail
pending fixture refinement. The body behavior they test is already
locked in by mocked unit tests in
bot/test/integration/boat-workflow.test.js (F12, F15, F9 each have
a passing unit test). The arena tests are supplementary: they'd
catch terrain-physics bugs that mocked blockAt misses.

Why the @xfail:
  - landfolk-test isn't a blank slate. The first iteration of these
    fixtures revealed natural water and odd block layouts within
    even a /fill'd region (e.g. water at (5021, 62, *) when our
    fixture only filled (5022..5024, 62, *) — possibly water flow
    from a source, or chunk-load timing).
  - The fixture needs to either (a) use a more aggressive
    clear_region with a wider span to displace natural terrain,
    or (b) use a region MUCH further from spawn (e.g. y=200 sky
    arena where we have absolute world control).
  - Each test runs ~5s and exposes real mineflayer + Paper
    behavior. They're worth completing but it's a session of
    fixture iteration on top of the bot work.

Run when fixtures are finalized:
    ./scripts/run-tester-bot.sh                 # in another shell
    pytest tests/functional/test_water_navigation.py -v -m functional

Next steps (next session):
  - Move ARENA_X / ARENA_Z to a guaranteed-empty region (e.g.
    y=200 sky arena, or a far-away chunk that's been verified
    void).
  - Maybe add a `_verify_clean(rcon, world, ...)` helper that
    asserts the region IS empty after _clear_region (catches
    landfolk-test-natural-terrain contamination immediately).
  - Re-enable each test by removing @pytest.mark.xfail.
"""

from __future__ import annotations

import time

import pytest


# Test region in landfolk-test. Chosen to be far from the L0/L3/L8
# fixture regions (which all live near (0, 65, 0)) so concurrent
# test runs don't collide. Each scenario uses its own sub-region
# within this block.
ARENA_X = 5000
ARENA_Z = 5000


def _clear_region(rcon, world: str, x0: int, z0: int, span: int = 32) -> None:
    """Wipe a span × span column: stone at y=60 (single-block floor),
    air everywhere else from y=61 up to y=90. Critically, y=63 (the
    head clearance cell above a y=62 water surface) is left as air so
    water fills at y=61..62 produce a CLASSIFY_CELL='navigable' result.

    First version made y=60..63 stone (3-block floor) — water fills
    overlaid the lower blocks but y=63 stayed stone, leaving every
    scenario unnavigable. The F9 in_water_rescue test failed because
    of THIS fixture bug, not the body code. Arena tests caught it,
    which is exactly the point of arena tests."""
    x1, z1 = x0 + span, z0 + span
    rcon.batch([
        f"execute in {world} run forceload add {x0} {z0} {x1} {z1}",
        f"execute in {world} run fill {x0} 60 {z0} {x1} 90 {z1} minecraft:air",
        f"execute in {world} run fill {x0} 60 {z0} {x1} 60 {z1} minecraft:stone",
    ])
    time.sleep(0.8)


def _release_region(rcon, world: str, x0: int, z0: int, span: int = 32) -> None:
    x1, z1 = x0 + span, z0 + span
    rcon.batch([
        f"execute in {world} run forceload remove {x0} {z0} {x1} {z1}",
    ])


# ───────────────────────────── F15 regression ─────────────────────────────

@pytest.mark.functional
@pytest.mark.xfail(reason="fixture iteration needed: landfolk-test has natural terrain interacting with /fill — see module docstring", strict=False)
def test_sail_to_nearest_candidate_skips_shallow_water(bot, rcon, arena, config):
    """F15 (v37): nearest_water_candidate must reject 1-deep ponds.

    Scenario: bot at (X, 64, Z). 15 east: a 3×3 shallow pond
    (water at y=63 + sand at y=62 — only 1 deep, boat would
    ground). 40 east: deep navigable water (y=62 + y=63 + air x2).
    Pre-F15 the closer shallow water was suggested; post-fix the
    deep one must win.
    """
    world = config["mc"]["world"]
    x0, z0 = ARENA_X, ARENA_Z
    bx, by, bz = x0 + 8, 64, z0 + 8

    bot.wait_until_ready(timeout=10)
    _clear_region(rcon, world, x0, z0)
    rcon.batch([
        # Shallow pond at (x0+23, y=62, z0+8) — 15 east of bot. Floor
        # (sand) at y=61, water surface at y=62, air above → 1-deep.
        f"execute in {world} run fill {x0+22} 61 {z0+7} {x0+24} 61 {z0+9} minecraft:sand",
        f"execute in {world} run fill {x0+22} 62 {z0+7} {x0+24} 62 {z0+9} minecraft:water",
        # Deep navigable water at (x0+48, y=62, z0+8) — 40 east.
        # water at y=61 and y=62 → 2-deep, surface at y=62.
        f"execute in {world} run fill {x0+46} 61 {z0+6} {x0+52} 62 {z0+10} minecraft:water",
        # Bot stance: tp to (bx, by, bz), give boat.
        f"execute in {world} run tp Tester {bx} {by} {bz} 0 0",
        "give Tester oak_boat 1",
    ])
    time.sleep(1.5)

    r = bot.post("/action/sail_to", {"x": x0 + 200, "y": 63, "z": bz})
    assert r.get("ok") is False, f"expected failure (no navigable route from inland): {r}"
    err = r.get("error", {})
    assert err.get("code") == "NO_NAVIGABLE_ROUTE", err
    obs = err.get("observed_state") or {}
    cand = obs.get("nearest_water_candidate")
    assert cand, f"expected nearest_water_candidate, got observed_state={obs}"
    # The candidate must be the DEEP water (x≥x0+46), NOT the shallow
    # pond (x∈x0+22..x0+24). Pre-F15 the closer shallow won.
    assert cand["x"] >= x0 + 46, (
        f"F15 regression: candidate x={cand['x']} is the shallow pond "
        f"(expected x≥{x0+46} for deep water). Full envelope: {r}"
    )

    _release_region(rcon, world, x0, z0)


# ───────────────────────────── F12 regression ─────────────────────────────

@pytest.mark.functional
@pytest.mark.xfail(reason="fixture iteration needed: landfolk-test has natural terrain interacting with /fill — see module docstring", strict=False)
def test_sail_to_nearest_candidate_skips_cave_pool(bot, rcon, arena, config):
    """F12 (v35): nearest_water_candidate must reject underground cave
    pools (no air directly above).

    Scenario: bot on surface. Cave pool 6b below (water at y=58
    with stone roof at y=59). Deep ocean 40b east with proper air
    above. Pre-fix, findBlocks returned the cave pool (3D-closest);
    post-fix the surface ocean wins.
    """
    world = config["mc"]["world"]
    x0, z0 = ARENA_X + 100, ARENA_Z
    bx, by, bz = x0 + 8, 64, z0 + 8

    bot.wait_until_ready(timeout=10)
    _clear_region(rcon, world, x0, z0)
    rcon.batch([
        # Cave pool at (x0+10, 58, z0+8) — water sealed under stone roof.
        # We need a SEALED pocket below the surface: water at y=58,
        # stone roof at y=59 (so y+1 above water is NOT air → cave).
        # Below the surface stone floor at y=60, we have to dig out
        # a pocket first (clear the stone we want to override).
        f"execute in {world} run fill {x0+9} 56 {z0+7} {x0+11} 60 {z0+9} minecraft:stone",
        f"execute in {world} run fill {x0+9} 58 {z0+7} {x0+11} 58 {z0+9} minecraft:water",
        # Surface ocean at (x0+48, 62, z0+8) — 2-deep, water at y=61+62,
        # air above (y=63+).
        f"execute in {world} run fill {x0+46} 61 {z0+6} {x0+52} 62 {z0+10} minecraft:water",
        f"execute in {world} run tp Tester {bx} {by} {bz} 0 0",
        "give Tester oak_boat 1",
    ])
    time.sleep(1.5)

    r = bot.post("/action/sail_to", {"x": x0 + 200, "y": 63, "z": bz})
    assert r.get("ok") is False
    err = r.get("error", {})
    assert err.get("code") == "NO_NAVIGABLE_ROUTE", err
    cand = (err.get("observed_state") or {}).get("nearest_water_candidate")
    assert cand, f"expected nearest_water_candidate, got {err}"
    # Cave pool sits at y=58. Surface ocean at y=62. F12 + F15 require
    # the surface answer.
    assert cand["y"] >= 61, (
        f"F12 regression: candidate y={cand['y']} is the cave pool "
        f"(expected y≥61 for surface water). Envelope: {r}"
    )
    assert cand["x"] >= x0 + 46, (
        f"candidate x={cand['x']} is not in the surface ocean cluster. {r}"
    )

    _release_region(rcon, world, x0, z0)


# ───────────────────────────── F9 regression ─────────────────────────────

@pytest.mark.functional
@pytest.mark.xfail(reason="fixture iteration needed: landfolk-test has natural terrain interacting with /fill — see module docstring", strict=False)
def test_sail_to_in_water_rescue_places_boat_at_bot(bot, rcon, arena, config):
    """F9 (v33): when sail_to is called while the bot is submerged
    (deep ocean drop, fell off pier, etc.), it must enter the
    in_water_rescue branch and place a boat at the bot's foot
    instead of trying to walk to a distant entry_shore.

    Scenario: 30×30 water pond, 2-deep, with a proper beach to the
    east (stone at y=61, air at y=62 = walkable foot). Bot dropped
    in the middle. sail_to target = a coord on the beach.

    The BFS plan: entry_water = bot's current cell, exit_water =
    pond cell adjacent to beach, exit_shore = beach cell with
    air-foot/stone-below at the water surface y. With those, plan
    succeeds and F9's in_water_rescue branch fires.

    Expected: phases_executed contains 'in_water_rescue' (either
    on success OR in a SAIL_FAILED envelope after the rescue path
    started). The arena fixture itself is the regression: pre-F9
    sail_to had no branch to take when the bot started in water,
    so 'in_water_rescue' would never appear.
    """
    world = config["mc"]["world"]
    x0, z0 = ARENA_X + 200, ARENA_Z
    pond_w, pond_h = 30, 30
    bx, by, bz = x0 + 15, 62, z0 + 15  # mid-pond
    # Target on the beach east of the pond. The beach is at y=62
    # (air foot, stone at y=61 below), so target y=62.
    target_x, target_z = x0 + pond_w + 3, z0 + 15

    bot.wait_until_ready(timeout=10)
    _clear_region(rcon, world, x0, z0, span=50)
    rcon.batch([
        # 2-deep water pond at y=61..62, x0..x0+pond_w.
        f"execute in {world} run fill {x0} 61 {z0} {x0+pond_w} 62 {z0+pond_h} minecraft:water",
        # East BEACH: stone at y=61 (walkable surface), air at y=62+
        # so the BFS sees this as shore (foot=air, below=stone).
        # Extends from pond_w+1 to pond_w+8 east.
        f"execute in {world} run fill {x0+pond_w+1} 61 {z0} {x0+pond_w+8} 61 {z0+pond_h} minecraft:stone",
        # tp bot into mid-pond. y=62.5 → foot at y=62 (water).
        f"execute in {world} run tp Tester {bx} {by + 0.5} {bz} 0 0",
        "give Tester oak_boat 2",
    ])
    time.sleep(2.0)  # bot must register as submerged

    r = bot.post(
        "/action/sail_to",
        {"x": target_x, "y": 62, "z": target_z},
        timeout=60,
    )
    # The rescue phase must appear in phases_executed whether the
    # overall journey succeeds or fails downstream. observed_state
    # on failure also surfaces phases.
    phases = (r.get("data") or {}).get("phases_executed") or []
    if not phases:
        # Failure paths sometimes don't propagate phases — check
        # error envelope for evidence the rescue branch was taken.
        err = r.get("error", {}) or {}
        # Pre-F9: sail_to would have returned MOUNT_FAILED with no
        # rescue-related code. Post-F9: RESCUE_PLACE_FAILED /
        # RESCUE_MOUNT_FAILED tell us the branch executed even if
        # it ultimately failed downstream.
        err_code = err.get("code", "")
        assert err_code.startswith("RESCUE_") or "in_water_rescue" in str(err), (
            f"F9 regression: in_water_rescue did NOT fire. "
            f"phases_executed={phases}, error={err}, full envelope: {r}"
        )
    else:
        assert "in_water_rescue" in phases, (
            f"F9 regression: in_water_rescue not in phases. "
            f"phases_executed={phases}, full envelope: {r}"
        )

    _release_region(rcon, world, x0, z0, span=50)
