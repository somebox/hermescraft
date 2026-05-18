"""Migration exemplar — was scripts/test-nav-reachable.py (227 LOC).

F48 verification: `mc reachable` introspection + enriched `mc goto_near`
nav errors. Reproduces the G21 v2 trap that stuck Mason at (2.3, 65, 12.7)
trying to reach (0, 65, 12) — a 1-block-thick cobble wall at y=66 along
z=12 leaves every cell along that row head_blocked. The only valid stand
cell within range 1 is (0, 65, 13).

This file exists to prove the new pytest harness end-to-end. The Round 3
migration of the other 43 functional tests will follow the same pattern.

Requires: live MC server + bot running at config.bot.default_api_url with
the bot named `Tester` (see config/hermescraft.yaml).
"""

from __future__ import annotations

import pytest


# Module-scoped fixture: build the Mason trap once for all four tests in
# this file. Scenarios B, C, and D depend on the geometry set up by A in
# the original test — preserving that semantic by sharing the arena.
#
# Consumes `tester_bot` (session-scoped) rather than `bot` (function-scoped)
# because the fixture itself runs at module scope. The function-scoped
# `bot` parameter on each test below resolves to the same tester_bot.
@pytest.fixture(scope="module")
def mason_trap(rcon, config, tester_bot):
    """Build cobble wall at y=66 z=12 (x: -2..1), grass floor at y=64,
    place Tester at (2.5, 65, 12.7). Cleanup on teardown."""
    tester_bot.wait_until_ready(timeout=10)
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run time set noon",
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -5 65 5 5 70 18 minecraft:air",
        f"execute in {world} run fill -5 64 5 5 64 18 minecraft:grass_block",
        # North wall at z=12, x=-2..1, y=66..68 (3 high) — the trap.
        f"execute in {world} run fill -2 66 12 1 68 12 minecraft:cobblestone",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
    ])
    # Canonical step 2: place_player tps + waits stationary. Avoids the
    # mid-air race a raw tp + fixed sleep had (gravity vs. assert).
    from tests._lib import Arena
    Arena(rcon, config).place_player(tester_bot, 2.5, 65, 12.7)
    yield
    # Teardown: fill the test box with air and park Tester at home.
    rcon.batch([
        f"execute in {world} run fill -5 65 5 5 70 18 minecraft:air",
        f"execute in {world} run tp Tester 52 65 52",
    ])


def _err(response: dict) -> tuple[str, str, dict]:
    err = response.get("error")
    if isinstance(err, dict):
        return err.get("code", ""), err.get("message", ""), err.get("observed_state") or {}
    if isinstance(err, str):
        return "", err, {}
    return "", "", {}


@pytest.mark.functional
def test_reachable_reports_head_blocked_for_unreachable_target(bot, mason_trap):
    """A: mc reachable 0 65 12 → target_standable=false, head_blocked, best_stand within range 1.5."""
    r = bot.post("/action/reachable", {"x": 0, "y": 65, "z": 12}, timeout=10)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("target_standable") is False, data
    assert data.get("target_reason") == "head_blocked", data
    assert (data.get("best_stand") or {}).get("distance", 99) <= 1.5, data


@pytest.mark.functional
def test_reachable_reports_standable_for_valid_cell(bot, mason_trap):
    """B: mc reachable 0 65 13 → target_standable=true."""
    r = bot.post("/action/reachable", {"x": 0, "y": 65, "z": 13}, timeout=10)
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("target_standable") is True, data
    assert data.get("target_reason") == "ok", data


@pytest.mark.functional
def test_goto_near_enriches_error_with_closest_standable(bot, mason_trap):
    """C: mc goto_near 0 65 12 range=1 → error carries closest_standable + target_reason.

    Whether the bot ultimately succeeds depends on whether (0,65,13) is within
    range=1 of (0,65,12) (distance exactly 1.0 is borderline). The KEY test is
    the diagnostic enrichment, not the nav outcome.
    """
    r = bot.post("/action/goto_near", {"x": 0, "y": 65, "z": 12, "range": 1}, timeout=25)
    if r.get("ok"):
        pytest.skip("goto_near succeeded — borderline-distance case; enrichment check skipped")
    _code, _msg, obs = _err(r)
    assert obs.get("closest_standable") is not None, obs
    assert obs.get("target_reason") in ("head_blocked", "foot_blocked"), obs


@pytest.mark.functional
def test_reachable_is_pose_independent(rcon, bot, config, mason_trap):
    """D: bot at (0,65,13), mc reachable 0 65 12 still reports head_blocked."""
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 0.5 65 13.5 180 0")
    import time
    time.sleep(0.5)
    r = bot.post("/action/reachable", {"x": 0, "y": 65, "z": 12}, timeout=10)
    data = r.get("data") or {}
    assert data.get("target_standable") is False, data
    assert data.get("target_reason") == "head_blocked", data
