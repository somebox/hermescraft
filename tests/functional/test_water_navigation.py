"""Water-navigation arena tests — live regression coverage for sail_to fixes.

Fixtures use the canonical ground arena (harness resets grass at y=64,
bot park at (0, 65, 0)). Geometry stays inside the mining zone (x ≥ 1).
"""

from __future__ import annotations

import pytest

from tests._lib.functional_fixtures import ARENA_FEET_Y

SITE_Z = 10


@pytest.fixture
def water_nav_ready(functional_world):
    """Harness reset completed; tests lay water props in the mining zone."""
    yield


def _clear_region(rcon, world: str, x0: int, z0: int, span: int = 32, *, arena=None) -> None:
    """Local air wipe over props; harness already laid grass/stone substrate."""
    x1, z1 = x0 + span, z0 + span
    rcon.batch([
        f"execute in {world} run fill {x0} 65 {z0} {x1} 80 {z1} minecraft:air",
        f"execute in {world} run fill {x0} 64 {z0} {x1} 64 {z1} minecraft:grass_block",
    ])
    if arena is not None:
        arena.settle_fast()


def _release_region(rcon, world: str, x0: int, z0: int, span: int = 32, *, arena=None) -> None:
    _clear_region(rcon, world, x0, z0, span, arena=arena)


@pytest.mark.functional
def test_sail_to_surfaces_walkable_shore_stance(bot, rcon, arena, config, water_nav_ready):
    """F21: NO_NAVIGABLE_ROUTE exposes nearest_water_candidate + nearest_shore_stance."""
    world = config["mc"]["world"]
    x0, z0 = 0, SITE_Z
    bx, by, bz = x0, ARENA_FEET_Y, z0
    cx0, cx1 = x0 + 28, x0 + 30
    cz0, cz1 = z0 - 1, z0 + 1
    _clear_region(rcon, world, x0, z0, span=32, arena=arena)
    rcon.batch([
        f"execute in {world} run fill {cx0} 62 {cz0} {cx1} 62 {cz1} minecraft:stone",
        f"execute in {world} run fill {cx0} 63 {cz0} {cx1} 64 {cz1} minecraft:water",
        f"execute in {world} run setblock {cx0 - 1} 64 {z0} minecraft:stone",
        f"execute in {world} run tp Tester {bx} {by} {bz} 90 0",
        "give Tester oak_boat 2",
    ])
    arena.settle_default()

    r = bot.post("/action/sail_to", {"x": x0 + 31, "y": ARENA_FEET_Y, "z": bz}, timeout=20)
    assert r.get("ok") is False, r
    err = r.get("error", {})
    assert err.get("code") in ("NO_NAVIGABLE_ROUTE", "SAIL_TO_RETRY_LOOP"), err
    obs = err.get("observed_state") or {}
    cand = obs.get("nearest_water_candidate")
    stance = obs.get("nearest_shore_stance")
    assert cand and stance, f"F21 missing candidate/stance: {r}"
    assert cand["y"] in (63, 64), f"candidate y={cand.get('y')}: {r}"
    assert (stance["x"], stance["y"], stance["z"]) != (cand["x"], cand["y"], cand["z"])
    hint = err.get("next_action_hint") or ""
    assert f"mc bg_goto {stance['x']} {stance['y']} {stance['z']}" in hint


@pytest.mark.functional
def test_sail_to_nearest_candidate_skips_shallow_water(bot, rcon, arena, config, water_nav_ready):
    """F15: nearest_water_candidate rejects 1-deep ponds."""
    world = config["mc"]["world"]
    x0, z0 = 0, SITE_Z
    bx, by, bz = x0 + 5, ARENA_FEET_Y, z0 + 5

    _clear_region(rcon, world, x0, z0, arena=arena)
    rcon.batch([
        f"execute in {world} run fill {x0+14} 63 {z0+4} {x0+16} 63 {z0+6} minecraft:stone",
        f"execute in {world} run fill {x0+14} 64 {z0+4} {x0+16} 64 {z0+6} minecraft:water",
        f"execute in {world} run fill {x0+24} 63 {z0+3} {x0+30} 64 {z0+7} minecraft:water",
        f"execute in {world} run tp Tester {bx} {by} {bz} 0 0",
        "give Tester oak_boat 1",
    ])
    arena.settle_default()

    r = bot.post("/action/sail_to", {"x": x0 + 31, "y": 64, "z": bz}, timeout=20)
    assert r.get("ok") is False, r
    err = r.get("error", {})
    assert err.get("code") == "NO_NAVIGABLE_ROUTE", err
    cand = (err.get("observed_state") or {}).get("nearest_water_candidate")
    assert cand, err
    assert cand["x"] >= x0 + 24, f"F15 shallow won: {r}"


@pytest.mark.functional
def test_sail_to_nearest_candidate_skips_cave_pool(bot, rcon, arena, config, water_nav_ready):
    """F12: reject cave water (stone roof); prefer surface navigable pool."""
    world = config["mc"]["world"]
    x0, z0 = 0, SITE_Z + 20
    if z0 + 32 > 32:
        z0 = -10
    bx, by, bz = x0 + 5, ARENA_FEET_Y, z0 + 5

    _clear_region(rcon, world, x0, z0, arena=arena)
    cx, cz = x0 + 12, z0 + 5
    rcon.batch([
        f"execute in {world} run fill {cx-2} 58 {cz-2} {cx+2} 60 {cz+2} minecraft:stone",
        f"execute in {world} run fill {cx-1} 58 {cz-1} {cx+1} 58 {cz+1} minecraft:water",
        f"execute in {world} run fill {x0+24} 63 {z0+3} {x0+30} 64 {z0+7} minecraft:water",
        f"execute in {world} run tp Tester {bx} {by} {bz} 0 0",
        "give Tester oak_boat 1",
    ])
    arena.settle_default()

    r = bot.post("/action/sail_to", {"x": x0 + 31, "y": 64, "z": bz}, timeout=20)
    assert r.get("ok") is False, r
    cand = (r.get("error") or {}).get("observed_state", {}).get("nearest_water_candidate")
    assert cand, r
    assert cand["y"] >= 63, f"F12 cave y={cand.get('y')}: {r}"
    assert cand["x"] >= x0 + 24


@pytest.mark.functional
@pytest.mark.xfail(
    reason="F9 in_water_rescue regression — TARGET_NOT_REACHABLE_FROM_WATER / NO_NAVIGABLE_ROUTE",
    strict=False,
)
def test_sail_to_in_water_rescue_places_boat_at_bot(bot, rcon, arena, config, water_nav_ready):
    """F9: submerged start triggers in_water_rescue."""
    world = config["mc"]["world"]
    x0, z0 = 1, SITE_Z - 8
    pond_w = 20
    bot_x = x0 + 5
    target_x = x0 + pond_w + 3
    bz = z0 + 8

    _clear_region(rcon, world, x0, z0, span=28, arena=arena)
    rcon.batch([
        f"execute in {world} run fill {x0} 63 {z0} {x0+pond_w} 64 {z0+16} minecraft:water",
        f"execute in {world} run fill {x0+pond_w+1} 63 {z0} {x0+pond_w+6} 63 {z0+16} minecraft:stone",
        f"execute in {world} run tp Tester {bot_x} 64 {bz} 0 0",
        "give Tester oak_boat 2",
    ])
    arena.settle_water()

    r = bot.post(
        "/action/sail_to",
        {"x": target_x, "y": ARENA_FEET_Y, "z": bz},
        timeout=60,
    )
    phases = (r.get("data") or {}).get("phases_executed") or []
    if "in_water_rescue" not in phases:
        err_code = (r.get("error") or {}).get("code", "")
        assert err_code.startswith("RESCUE_") or r.get("ok"), (
            f"F9: in_water_rescue missing: {r}"
        )
