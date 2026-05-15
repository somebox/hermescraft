"""F54.5: `mc through` returns NOT_A_DOOR with actionable next-action hint.

Migrated from scripts/test-through-recovery.py with an assertion
upgrade for the gate-pass scenario (inventory-flagged: legacy only
checked ok=true, now verifies the bot actually crossed to the far side).

Three scenarios:
  A: target is air + bot has oak_door in inv → NOT_A_DOOR with hint
     suggesting 'mc place oak_door' and observed_state.inventory_door='oak_door'.
  B: target is a cobblestone wall → NOT_A_DOOR with hint to dig or pick real door.
  C: target IS an oak door → ok=true AND bot is on the far side (z>3.5).
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def through_arena_v2(rcon, arena, flint_bot, config):
    """Larger arena (31×31) so the bot at z=1 reaching z=3+ stays in-bounds."""
    flint_bot.wait_until_ready(timeout=10)
    arena.clean()
    arena.flat_arena((-10, 64, -10, 20, 80, 20), floor="stone")
    arena.settle()
    yield
    arena.flat_arena((-10, 60, -10, 20, 80, 20), floor="stone")


def _next_action_hint(response: dict) -> str:
    """The hint can live in error.next_action_hint or top-level next_action_hint
    depending on the verb's envelope shape."""
    err = response.get("error")
    if isinstance(err, dict) and err.get("next_action_hint"):
        return str(err.get("next_action_hint"))
    return str(response.get("next_action_hint") or "")


@pytest.mark.functional
def test_through_air_with_door_in_inv_suggests_place(bot, rcon, arena, config, through_arena_v2):
    """A: target air at (4,65,3), bot has oak_door → NOT_A_DOOR + hint
    'mc place oak_door' + inventory_door='oak_door'."""
    world = config["mc"]["world"]
    rcon.batch([
        "clear Flint",
        "give Flint minecraft:oak_door 2",
        f"execute in {world} run tp Flint 3 65 3 0 0",
    ])
    arena.settle()
    r = bot.post("/action/through", {"gx": 4, "gy": 65, "gz": 3}, timeout=20)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "NOT_A_DOOR", r
    assert obs.get("is_air") is True, obs
    assert obs.get("inventory_door") == "oak_door", obs
    hint = _next_action_hint(r).lower()
    assert "mc place" in hint and "oak_door" in hint, r


@pytest.mark.functional
def test_through_wall_block_suggests_dig_or_real_door(bot, rcon, arena, config, through_arena_v2):
    """B: target is cobble at (4,65,3) → NOT_A_DOOR + hint mentions dig
    or 'real door' so the brain doesn't infinite-loop."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 4 65 3 minecraft:cobblestone",
        "clear Flint",
        f"execute in {world} run tp Flint 3 65 3 0 0",
    ])
    arena.settle()
    r = bot.post("/action/through", {"gx": 4, "gy": 65, "gz": 3}, timeout=20)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "NOT_A_DOOR", r
    assert obs.get("block_at_target") == "cobblestone", obs
    assert obs.get("is_air") is False, obs
    hint = _next_action_hint(r).lower()
    assert "dig" in hint or "real door" in hint, r


@pytest.mark.functional
def test_through_real_door_traverses(bot, rcon, arena, config, through_arena_v2):
    """C: real oak_door at (4,65,3), bot at (4,65,1) facing north → ok
    AND bot ends up on the far side (z>3.5). Inventory-flagged upgrade:
    the legacy only checked ok=true, now we verify the side effect."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill 2 65 2 6 67 4 minecraft:air",
        f"execute in {world} run setblock 4 65 3 minecraft:oak_door[half=lower,facing=south]",
        f"execute in {world} run setblock 4 66 3 minecraft:oak_door[half=upper,facing=south]",
        "clear Flint",
        f"execute in {world} run tp Flint 4 65 1 180 0",
    ])
    arena.settle(seconds=2.0)
    r = bot.post("/action/through", {"gx": 4, "gy": 65, "gz": 3}, timeout=30)
    assert r.get("ok"), r
    pos = bot.position()
    assert pos.get("z", -99) >= 3.5, f"through ok=true but bot at {pos} — never crossed"
