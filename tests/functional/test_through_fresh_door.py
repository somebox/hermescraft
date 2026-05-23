"""F55.4: `mc through` re-fetches block state once if first read is air.

Migrated from scripts/test-through-fresh-door.py. Without F55.4, when
a door is placed via rcon and mc through is called immediately,
mineflayer's block snapshot may not have synced — through reads air,
returns NOT_A_DOOR, agent loops. F55.4 re-reads once before declaring
not-a-door.

Scenarios:
  A: door placed, mc through called immediately → error code is NOT
     NOT_A_DOOR / GATE_NOT_FOUND (re-fetch saw the door).
  B: bot caged in bedrock, real door 25m away → TRAVERSAL_FAILED with
     observed_state.gate_block='oak_door'.
  C: target is permanently air → NOT_A_DOOR with is_air=true (F54.5 regression check).
"""

from __future__ import annotations

import pytest

from tests._lib import extract_error


@pytest.fixture
def fresh_door_arena(rcon, arena, tester_bot, config):
    """Larger flat region; bot at (0,65,0) facing east. Each test places
    its own door + obstacles."""
    world = config["mc"]["world"]
    # Lift bot to safe high-Y before rebuilding floor.
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.batch([
        "clear Tester",
        f"execute in {world} run tp Tester 0 65 0 90 0",
    ])
    arena.settle()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")


@pytest.mark.functional
def test_through_recognizes_freshly_placed_door(bot, rcon, config, fresh_door_arena):
    """A: door placed at (3,66,0), through called immediately. F55.4
    re-fetch should pick up the door. Error (if any) must NOT be
    NOT_A_DOOR or GATE_NOT_FOUND. The actual traversal may fail for
    other reasons (pathfinder quirks) — that's pre-existing through()
    behavior, not part of F55.4."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 3 66 0 minecraft:oak_door[half=lower,facing=east]",
        f"execute in {world} run setblock 3 67 0 minecraft:oak_door[half=upper,facing=east]",
    ])
    r = bot.post("/action/through", {"gx": 3, "gy": 66, "gz": 0}, timeout=20)
    code, _, _ = extract_error(r)
    assert code not in {"NOT_A_DOOR", "GATE_NOT_FOUND"}, r


@pytest.mark.functional
def test_through_caged_bot_returns_traversal_failed_with_gate_info(bot, rcon, arena, config, fresh_door_arena):
    """B: bot in bedrock cage, door 25m away → TRAVERSAL_FAILED with
    observed_state.gate_block='oak_door' (so agent knows the door exists
    but can't be reached)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 25 66 0 minecraft:oak_door[half=lower,facing=east]",
        f"execute in {world} run setblock 25 67 0 minecraft:oak_door[half=upper,facing=east]",
        # 6-sided bedrock cage at (0,65,0)
        f"execute in {world} run setblock 1 65 0 minecraft:bedrock",
        f"execute in {world} run setblock 1 66 0 minecraft:bedrock",
        f"execute in {world} run setblock -1 65 0 minecraft:bedrock",
        f"execute in {world} run setblock -1 66 0 minecraft:bedrock",
        f"execute in {world} run setblock 0 65 1 minecraft:bedrock",
        f"execute in {world} run setblock 0 66 1 minecraft:bedrock",
        f"execute in {world} run setblock 0 65 -1 minecraft:bedrock",
        f"execute in {world} run setblock 0 66 -1 minecraft:bedrock",
        f"execute in {world} run setblock 0 67 0 minecraft:bedrock",
    ])
    arena.settle()
    r = bot.post("/action/through", {"gx": 25, "gy": 66, "gz": 0}, timeout=20)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "TRAVERSAL_FAILED", r
    assert obs.get("gate_block") == "oak_door", obs


@pytest.mark.functional
def test_through_air_target_returns_not_a_door(bot, fresh_door_arena):
    """C: target is air at (7,66,0) with no door anywhere → NOT_A_DOOR
    with is_air=true. F54.5 regression check."""
    r = bot.post("/action/through", {"gx": 7, "gy": 66, "gz": 0}, timeout=15)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "NOT_A_DOOR", r
    assert obs.get("is_air") is True, obs
