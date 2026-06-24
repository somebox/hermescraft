"""F73 live smoke: reachable `goto_near` reports walkable_to_target=true.

Unreachable + next_hop cases are covered in `bot/test/runtime/nav-brief-repair.test.js`.
See `docs/testing/nav-parity-audit.md`. Spatial need: open_flat. Pad: Origin.
"""

from __future__ import annotations

import math
import pytest


@pytest.fixture
def reachability_arena(rcon, arena, config, functional_world):
    world = config["mc"]["world"]
    from tests._lib.functional_fixtures import ensure_arena_forceload

    arena.forceload((-1, -1, 1, 1))
    yield
    ensure_arena_forceload(rcon, world)


def _observed_state(response: dict) -> dict:
    obs = dict(response.get("observed_state") or (response.get("data") or {}).get("observed_state") or {})
    data = response.get("data") or {}
    for key in ("walkable_to_target", "next_hop_suggestion"):
        if key in data and key not in obs:
            obs[key] = data[key]
    return obs


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
