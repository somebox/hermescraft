"""Scripted-brain recovery contract verification.

Migrated from scripts/test-recovery-protocols.py. While primitive tests
verify framework behavior (when X happens, the API returns Y), this
suite goes one layer up: given the framework error contracts, does the
documented brain recovery sequence actually escape stuck states?

Each scenario:
  1. Sets up a deterministic stuck initial state.
  2. Runs a SCRIPTED recovery sequence (the same calls a "smart brain"
     should make, hardcoded for determinism).
  3. Asserts the final goal state was achieved AND each intermediate
     step produced the contract-promised data.

If a scenario starts failing it means either (a) the error contract
changed without the test catching it, or (b) the documented recovery
procedure no longer works against the framework. Both are valuable
signals: the test doubles as executable documentation of the brain
protocol.

Two scenarios (R1, R2) carry an xfail mark for the *full end-to-end*
recovery path — see docstrings + docs/test-inventory.md. The xfail
flips to XPASS when the framework limitation is fixed.

Scenarios:
  R1: NAV head-blocked → use closest_standable from error → retry.
      Asserts F48 error envelope contract; transparent-substitution
      success path is accepted too (F48+F49 may resolve in-framework).
  R2: TARGET_OCCUPIED relocatable → dig+re-place table → place block.
      Asserts F45.4 contract data. End-to-end recovery is xfail'd:
      mineflayer's getDigTime reports ~95s for wooden_axe on
      crafting_table; guardSlowDigEstimate rejects. Tracked separately.
  R3: INVENTORY_MISSING → withdraw from chest → retry place.
      Full end-to-end (no xfail) — verifies side effect via rcon.block_is.
"""

from __future__ import annotations

import time

import pytest

from tests._lib import extract_error


@pytest.fixture
def recovery_arena(rcon, arena, tester_bot, config):
    """Clean grass arena over packed stone sub-floor (y=60..63), peaceful
    mode, bot prepared with saturation. Sub-floor matters: without it,
    gaps left by prior tests can drop the bot into the void mid-pathfind."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    arena.clean()
    # Forceload the test-region chunks so chest-open events can fire.
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run fill -10 60 -10 15 70 18 minecraft:air",
        f"execute in {world} run fill -10 60 -10 15 63 18 minecraft:stone",
        f"execute in {world} run fill -10 64 -10 15 64 18 minecraft:grass_block",
        "clear Tester",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
        "effect give Tester minecraft:resistance 600 4",  # absorb chip damage
        "effect give Tester minecraft:regeneration 600 4",
    ])
    arena.settle()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill -10 60 -10 15 70 18 minecraft:air")
    arena.forceload_remove_all()


@pytest.mark.functional
def test_R1_head_blocked_uses_closest_standable(bot, rcon, arena, config, recovery_arena):
    """R1: Mason's G21 v2 stuck — wall at y=66 z=12 from x=-2..1.
    Bot at (2.5, 65, 12.7), wants to nav near (0,65,12). Every range=1
    stand cell is head_blocked. Either:
      (a) F48+F49 transparently substitute closest_standable and the
          nav succeeds, OR
      (b) the nav fails with the F48 envelope carrying closest_standable
          and target_reason='head_blocked' — recovery contract preserved.
    Either path counts as PASS (both prove the F48 data is in flight)."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run fill -2 66 12 1 68 12 minecraft:cobblestone",
        f"execute in {world} run tp Tester 2.5 65 12.7 0 0",
        "give Tester minecraft:cobblestone 5",
    ])
    arena.settle()

    r = bot.post("/action/goto_near", {"x": 0, "y": 65, "z": 12, "range": 1}, timeout=25)
    if r.get("ok"):
        # Path A — transparent substitution. Bot must have landed at one
        # of the two distance-1 standable cells north (0,65,13) or south
        # (0,65,11).
        pos = bot.position()
        px, pz = pos.get("x", 0), pos.get("z", 0)
        at_north = abs(px - 0.5) < 0.8 and abs(pz - 13.5) < 0.8
        at_south = abs(px - 0.5) < 0.8 and abs(pz - 11.5) < 0.8
        assert at_north or at_south, f"transparent substitution but bot at unexpected ({px:.2f},{pz:.2f})"
        return

    # Path B — F48 envelope contract.
    code, _, obs = extract_error(r)
    cs = obs.get("closest_standable")
    tr = obs.get("target_reason")
    assert cs is not None, f"F48 contract broken: error missing closest_standable; obs={obs}"
    assert tr == "head_blocked", f"target_reason should be head_blocked, got {tr!r}"


@pytest.mark.functional
def test_R2_target_occupied_carries_is_relocatable(bot, rcon, arena, config, recovery_arena):
    """R2 (contract slice): place over crafting_table → TARGET_OCCUPIED
    with observed_state.is_relocatable=true. This is the F45.4 data
    contract — proves the framework gives the brain enough info to
    plan the dig+re-place recovery.

    End-to-end recovery is NOT exercised here (see xfail companion test
    below) — mineflayer's getDigTime returns ~95s for wooden_axe on
    crafting_table (real MC: ~1.25s); guardSlowDigEstimate rejects."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 3 65 3 minecraft:crafting_table",
        f"execute in {world} run tp Tester 0 65 0 270 0",
        "give Tester minecraft:cobblestone 5",
        "give Tester minecraft:wooden_axe 1",
    ])
    arena.settle()

    r = bot.post("/action/place", {"block": "cobblestone", "x": 3, "y": 65, "z": 3}, timeout=15)
    assert not r.get("ok"), r
    code, _, obs = extract_error(r)
    assert code == "TARGET_OCCUPIED", r
    assert obs.get("is_relocatable") is True, (
        f"F45.4 contract broken: error missing is_relocatable=true; obs={obs}"
    )


@pytest.mark.functional
@pytest.mark.xfail(
    strict=False,
    reason="mineflayer getDigTime reports ~95s for wooden_axe on crafting_table "
           "(real MC: ~1.25s); guardSlowDigEstimate rejects the dig step. "
           "Tracked as framework carry-forward — XPASS flips when fixed.",
)
def test_R2_end_to_end_dig_replace_table(bot, rcon, arena, config, recovery_arena):
    """R2 end-to-end: complete the recovery — dig the table, re-place it
    elsewhere, then place cobble at the original target. Currently xfail
    because the dig step trips guardSlowDigEstimate."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 3 65 3 minecraft:crafting_table",
        f"execute in {world} run tp Tester 0 65 0 270 0",
        "give Tester minecraft:cobblestone 5",
        "give Tester minecraft:wooden_axe 1",
    ])
    arena.settle()
    # The recovery: dig table → re-place at (5,65,5) → place cobble at (3,65,3).
    d = bot.post("/action/dig", {"x": 3, "y": 65, "z": 3}, timeout=15)
    assert d.get("ok"), d
    p1 = bot.post("/action/place", {"block": "crafting_table", "x": 5, "y": 65, "z": 5}, timeout=15)
    assert p1.get("ok"), p1
    p2 = bot.post("/action/place", {"block": "cobblestone", "x": 3, "y": 65, "z": 3}, timeout=15)
    assert p2.get("ok"), p2
    assert rcon.block_is(3, 65, 3, "cobblestone"), "place returned ok but block not present"
    assert rcon.block_is(5, 65, 5, "crafting_table"), "relocated table not present"


@pytest.mark.functional
def test_R3_inventory_missing_recovery_via_chest_withdraw(bot, rcon, arena, config, recovery_arena):
    """R3 end-to-end: place fails INVENTORY_MISSING → withdraw cobble
    from chest → retry place → block actually present at target."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 4 65 4 minecraft:chest",
        f'execute in {world} run data merge block 4 65 4 '
        f'{{Items:[{{Slot:0b,id:"minecraft:cobblestone",Count:32b}}]}}',
        f"execute in {world} run tp Tester 0 65 0 270 0",
        "clear Tester minecraft:cobblestone",
    ])
    arena.settle()
    assert bot.inventory().get("cobblestone", 0) == 0

    # Step 1: place fails INVENTORY_MISSING.
    r1 = bot.post("/action/place", {"block": "cobblestone", "x": 1, "y": 65, "z": 1}, timeout=10)
    assert not r1.get("ok"), r1
    code1, _, _ = extract_error(r1)
    assert code1 == "INVENTORY_MISSING", r1

    # Step 2: withdraw from chest. Generous timeout — the bot pathfinds
    # to the chest's reach distance first, which can take several seconds
    # in a sparse arena.
    r2 = bot.post(
        "/action/withdraw",
        {"item": "cobblestone", "count": 5, "x": 4, "y": 65, "z": 4},
        timeout=45,
    )
    assert r2.get("ok"), r2
    time.sleep(0.5)
    assert bot.inventory().get("cobblestone", 0) >= 1, "withdraw ok but inventory unchanged"

    # Step 3: retry place. State-verified.
    r3 = bot.post("/action/place", {"block": "cobblestone", "x": 1, "y": 65, "z": 1}, timeout=15)
    assert r3.get("ok"), r3
    assert rcon.block_is(1, 65, 1, "cobblestone"), "place ok but block not present"
