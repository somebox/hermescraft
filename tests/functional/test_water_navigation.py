"""Water-navigation arena — one live smoke for sail_to candidate selection (F15).

Deeper sail_to orchestration lives in bot/test/integration/boat-workflow.test.js.
"""

from __future__ import annotations

import pytest

from tests._lib.functional_fixtures import ARENA_FEET_Y


SITE_Z = 10


@pytest.fixture
def water_nav_ready(functional_world):
    yield


def _clear_region(rcon, world: str, x0: int, z0: int, span: int = 28, *, arena=None) -> None:
    x1, z1 = min(x0 + span, 32), min(z0 + span, 32)
    rcon.batch([
        f"execute in {world} run fill {x0} 65 {z0} {x1} 80 {z1} minecraft:air",
        f"execute in {world} run fill {x0} 64 {z0} {x1} 64 {z1} minecraft:grass_block",
    ])
    if arena is not None:
        arena.settle_fast()


@pytest.mark.functional
@pytest.mark.functional_core
def test_sail_to_nearest_candidate_skips_shallow_water(bot, rcon, arena, config, water_nav_ready):
    """F15: nearest_water_candidate rejects 1-deep ponds (mining zone x>=1)."""
    world = config["mc"]["world"]
    x0, z0 = 1, SITE_Z
    bx, by, bz = x0 + 5, ARENA_FEET_Y, z0 + 5

    _clear_region(rcon, world, x0, z0, span=28, arena=arena)
    rcon.batch([
        f"execute in {world} run fill {x0+14} 63 {z0+4} {x0+16} 63 {z0+6} minecraft:stone",
        f"execute in {world} run fill {x0+14} 64 {z0+4} {x0+16} 64 {z0+6} minecraft:water",
        f"execute in {world} run fill {x0+24} 63 {z0+3} {min(x0+30, 32)} 64 {z0+7} minecraft:water",
        f"execute in {world} run tp Tester {bx} {by} {bz} 0 0",
        "give Tester oak_boat 1",
    ])
    arena.settle_default()

    r = bot.post("/action/sail_to", {"x": min(x0 + 31, 32), "y": 64, "z": bz}, timeout=20)
    assert r.get("ok") is False, r
    err = r.get("error", {})
    assert err.get("code") == "NO_NAVIGABLE_ROUTE", err
    cand = (err.get("observed_state") or {}).get("nearest_water_candidate")
    assert cand, err
    assert cand["x"] >= x0 + 24, f"F15 shallow won: {r}"
