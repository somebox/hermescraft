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


@pytest.fixture
def mason_trap(rcon, config, functional_world):
    """Lay the Mason trap on top of the canonical harness reset.

    Runs after autouse `_functional_harness`. TP near the trap so the bot
    client loads the chunk before reachable scans."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill -5 65 5 5 70 18 minecraft:air",
        # North wall at z=12, x=-2..1, y=66..68 (3 high) — the trap.
        f"execute in {world} run fill -2 66 12 1 68 12 minecraft:cobblestone",
    ])
    from tests._lib import Arena
    arena = Arena(rcon, config)
    arena.teleport_bot(2.5, 65, 12.7, yaw=180.0)
    arena.settle_fast()
    yield
    rcon.batch([
        f"execute in {world} run fill -5 65 5 5 70 18 minecraft:air",
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
        # Transparent substitution (F48+F49): bot must land at a standable cell
        # adjacent to the trap, not skip enrichment checks entirely.
        pos = bot.position()
        px, pz = pos.get("x", 0), pos.get("z", 0)
        at_north = abs(px - 0.5) < 0.8 and abs(pz - 13.5) < 0.8
        at_south = abs(px - 0.5) < 0.8 and abs(pz - 11.5) < 0.8
        assert at_north or at_south, (
            f"goto_near ok but bot at unexpected ({px:.2f},{pz:.2f})"
        )
        return
    _code, _msg, obs = _err(r)
    assert obs.get("closest_standable") is not None, obs
    assert obs.get("target_reason") in ("head_blocked", "foot_blocked"), obs


@pytest.mark.functional
def test_reachable_is_pose_independent(rcon, bot, arena, config, mason_trap):
    """D: bot at (0,65,13), mc reachable 0 65 12 still reports head_blocked."""
    arena.place_player(bot, 0.5, 65, 13.5, yaw=180.0)
    r = bot.post("/action/reachable", {"x": 0, "y": 65, "z": 12}, timeout=10)
    data = r.get("data") or {}
    assert data.get("target_standable") is False, data
    assert data.get("target_reason") == "head_blocked", data
