"""F54.1: `mc dig` refuses to remove a block that supports a door/fence_gate.

Migrated from scripts/test-dig-door-support.py. Four scenarios share a
module-scoped fixture (the geometry already encodes scenario isolation
via `tp_adjacent`, so per-test rebuilds would only slow the suite).

Geometry note: support cobbles sit at y=65 (one block above the y=64
floor) and the doors/gates above them at y=66/67. Original placement
at y=64 conflicted with F66's dig LOS guard — the eye-to-floor raycast
passed through neighboring floor stones.

Scenarios:
  A: cobble at (5,65,0) supports oak_door at (5,66,0) → SUPPORT_BLOCK
     with observed_state.supported_block.name='oak_door'.
  B: same setup with force=true → ok + cobble is actually air (rcon-verified).
  C: plain cobble at (7,65,0), no door above → ok + cobble is air.
  D: cobble at (3,65,0) supports oak_fence_gate → SUPPORT_BLOCK with name='oak_fence_gate'.
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture(scope="module")
def dig_support_arena(rcon, config, flint_bot):
    """Build all 4 scenarios' geometry once. Each test calls `tp_adjacent`
    via the helper below to position the bot for its own dig.

    Rebuilding the SUPPORT_BLOCK scenarios mid-module isn't worthwhile —
    they're failure paths so the cobble + door remain in place between
    tests. The force-dig and plain-cobble scenarios (B, C) leave their
    target as air after running; the module finishes with those two
    consumed, which is fine since the module then teardown-cleans.
    """
    world = config["mc"]["world"]
    flint_bot.wait_until_ready(timeout=10)
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run time set noon",
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {world} run fill -10 64 -10 10 64 10 minecraft:stone",
        # Door-on-support (A, B)
        f"execute in {world} run setblock 5 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock 5 66 0 minecraft:oak_door[half=lower]",
        f"execute in {world} run setblock 5 67 0 minecraft:oak_door[half=upper]",
        # Plain cobble (C)
        f"execute in {world} run setblock 7 65 0 minecraft:cobblestone",
        # Fence-gate-on-support (D)
        f"execute in {world} run setblock 3 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock 3 66 0 minecraft:oak_fence_gate",
        f"execute in {world} run tp Flint 0 65 0 90 0",
        "clear Flint",
        "give Flint minecraft:wooden_pickaxe 1",
    ])
    time.sleep(1.5)
    yield
    rcon.batch([
        f"execute in {world} run fill -10 65 -10 10 80 10 minecraft:air",
        f"execute in {world} run tp Flint 52 65 52",
    ])


def _tp_adjacent(rcon, world: str, x: int, z: int) -> None:
    """TP Flint one block west of (x,65,z) facing east. Required so each
    scenario's eye-to-target raycast stays clean of sibling scenario
    blocks placed along x ∈ {3,5,7}."""
    rcon.run(f"execute in {world} run tp Flint {x - 1} 65 {z} 270 0")
    time.sleep(0.4)


@pytest.mark.functional
def test_dig_support_under_door_returns_support_block(bot, rcon, config, dig_support_arena):
    """A: SUPPORT_BLOCK with supported_block.name='oak_door'."""
    world = config["mc"]["world"]
    _tp_adjacent(rcon, world, 5, 0)
    r = bot.post("/action/dig", {"x": 5, "y": 65, "z": 0}, timeout=15)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "SUPPORT_BLOCK", r
    supp = obs.get("supported_block") or {}
    assert supp.get("name") == "oak_door", obs


@pytest.mark.functional
def test_dig_support_with_force_breaks_block(bot, rcon, config, dig_support_arena):
    """B: force=true overrides the guard AND the cobble actually becomes air
    (inventory-flagged upgrade: legacy used to only check ok=true)."""
    world = config["mc"]["world"]
    _tp_adjacent(rcon, world, 5, 0)
    r = bot.post("/action/dig", {"x": 5, "y": 65, "z": 0, "force": True}, timeout=20)
    assert r.get("ok"), r
    assert rcon.block_is(5, 65, 0, "air"), "force dig ok=true but cobble still present"


@pytest.mark.functional
def test_dig_plain_cobble_succeeds(bot, rcon, config, dig_support_arena):
    """C: cobble at (7,65,0) with no door above → ok AND block is air."""
    world = config["mc"]["world"]
    _tp_adjacent(rcon, world, 7, 0)
    r = bot.post("/action/dig", {"x": 7, "y": 65, "z": 0}, timeout=20)
    assert r.get("ok"), r
    assert rcon.block_is(7, 65, 0, "air"), "plain dig ok=true but cobble still present"


@pytest.mark.functional
def test_dig_support_under_fence_gate_returns_support_block(bot, rcon, config, dig_support_arena):
    """D: SUPPORT_BLOCK with supported_block.name='oak_fence_gate'."""
    world = config["mc"]["world"]
    _tp_adjacent(rcon, world, 3, 0)
    r = bot.post("/action/dig", {"x": 3, "y": 65, "z": 0}, timeout=15)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "SUPPORT_BLOCK", r
    supp = obs.get("supported_block") or {}
    assert supp.get("name") == "oak_fence_gate", obs
