"""pillar_step / pillar_down state invariants against the Tester body.

The unit-test layer (bot/test/actions/pillar-geometry.test.js,
pillar-tracking.test.js, excavation-contract.test.js) pins the COORDINATE
arithmetic and the contract envelopes — but it can't simulate the
mineflayer position lag, fractional-Y physics, or the real pickup-pathing
that the genesis run g-2026-05-27-10 observation file flagged
("next op doesn't realize where prev op stopped").

This file covers what the unit tests can't:

  A. Slab refusal — pillar_step from a slab top must surface
     PILLAR_FROM_PARTIAL_BLOCK; the bot must NOT move.
  B. Y-delta invariant — after pillar_step count=N from a full block,
     bot.position()['y'] from /status matches r['endY'] AND endY-startY == N.
  C. pillar_down position snapshot — the report's `position` field
     reflects the pillar-DOWN landing, not the post-pickup pathing
     location. The drop is spawned laterally so pickup MUST move the
     bot, exercising the snapshot guard.
  D. Move → pillar → check sequencing — drives the actual genesis
     symptom: chain mc move + mc pillar_step and verify each report's
     position matches /status after settle.

Uses the Tester bot. Arena geometry uses small 11x11 stone shells so
the bot can't accidentally walk off into voids during state reads.
"""

from __future__ import annotations

import time

import pytest


# Arena geometry — bedrock floor at y=50, stone shell up through y=63
# (bot stands at y=64 in the cavity above), open air from y=64 onward.
# 11x11 footprint so all four cardinal cells around any starting position
# are real stone (not edge cases).
ARENA_X_MIN, ARENA_X_MAX = -5, 5
ARENA_Z_MIN, ARENA_Z_MAX = -5, 5
ARENA_Y_BEDROCK = 50
ARENA_Y_FLOOR = 63        # top of solid stone (bot stands here +1)
ARENA_Y_STAND = 64        # bot foot Y in cavity above floor
ARENA_Y_CLEAR_TOP = 100


@pytest.fixture
def state_arena(rcon, config, tester_bot):
    """Flat stone floor, open air above. Bot at (0, 64, 0), clean inventory.
    Each test adds its own scenery (slab, dirt drop, etc.) and gives the
    bot whatever inventory it needs."""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        # Clear everything.
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_CLEAR_TOP} {ARENA_Z_MAX} minecraft:air",
        # Bedrock safety net.
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_BEDROCK} {ARENA_Z_MAX} minecraft:bedrock",
        # Stone floor up through y=63. Bot stands on y=63 top, so foot Y=64.
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK+1} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_FLOOR} {ARENA_Z_MAX} minecraft:stone",
        "clear Tester",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
        "gamemode survival Tester",
        f"execute in {world} run tp Tester 0.5 {ARENA_Y_STAND} 0.5 0 0",
    ])
    time.sleep(1.5)
    yield
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_CLEAR_TOP} {ARENA_Z_MAX} minecraft:air",
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_BEDROCK} {ARENA_Z_MAX} minecraft:bedrock",
        f"execute in {world} run tp Tester 0 {ARENA_Y_STAND + 5} 0 0 0",
    ])


# ─── A. Slab refusal ─────────────────────────────────────────────────────

@pytest.mark.functional
def test_pillar_step_refuses_from_slab(bot, rcon, config, state_arena, arena):
    """pillar_step on a slab top must surface PILLAR_FROM_PARTIAL_BLOCK
    and leave the bot where it was (no place attempt, no Y change).

    Unit test (pillar-tracking.test.js) pins the contract; this test
    confirms the same shape against a real body — the slab is a genuine
    minecraft:oak_slab, bot.position()['y'] is the real fractional 64.5,
    and the bot's POSITION must not move."""
    world = config["mc"]["world"]
    # Replace the full stone cell with a bottom slab so the bot stands on a
    # partial top (y≈63.5). TP Y must match slab geometry — rcon tp at 64.5
    # often snaps to y=64 on the stone neighbor in full-block collision.
    rcon.batch([
        f"execute in {world} run setblock 3 63 3 minecraft:oak_slab[type=bottom]",
        "give Tester minecraft:cobblestone 32",
        f"execute in {world} run tp Tester 3.5 63.5 3.5 0 0",
    ])
    arena.settle_default()
    before = bot.position() or {}
    assert before.get("y", 0) > 63.4, f"bot should be on slab top y≈63.5, was at {before}"

    r = bot.post("/action/pillar_step", {"count": 3}, timeout=15)
    assert r.get("ok") is False, f"expected refusal, got: {r}"
    assert r.get("error", {}).get("code") == "PILLAR_FROM_PARTIAL_BLOCK", (
        f"expected PILLAR_FROM_PARTIAL_BLOCK, got {r.get('error', {}).get('code')}: {r}"
    )
    # Confirm bot did NOT move (within tiny fractional jitter from packet
    # synchronization). Slab top stays at 64.5.
    after = bot.position() or {}
    assert abs(after.get("y", 0) - before.get("y", 0)) < 0.2, (
        f"bot Y should not change on guard refusal; before={before}, after={after}"
    )


@pytest.mark.functional
def test_pillar_step_force_bypasses_slab_guard(bot, rcon, config, state_arena, arena):
    """The force flag must allow pillar_step from a slab even though the
    guard warns about the off-by-one. (Caller acknowledges the math is
    weird; cleanup primitives sometimes need this.)"""
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run setblock 3 63 3 minecraft:oak_slab[type=bottom]",
        "give Tester minecraft:cobblestone 32",
        f"execute in {world} run tp Tester 3.5 63.5 3.5 0 0",
    ])
    arena.settle_default()
    # Whatever physics actually produces, the guard must not be the failure.
    r = bot.post("/action/pillar_step", {"count": 1, "force": True}, timeout=30)
    if r.get("ok") is False:
        assert r.get("error", {}).get("code") != "PILLAR_FROM_PARTIAL_BLOCK", (
            f"force=true must bypass the partial-block guard; got {r}"
        )


# ─── B. Y-delta invariant ────────────────────────────────────────────────

@pytest.mark.functional
def test_pillar_step_position_matches_report(bot, rcon, config, state_arena):
    """After pillar_step from a full block, /status (the bot's real
    position) must agree with the action report's `position` and `endY`.

    This is the "state sync between operations" invariant — if /status
    lags the report, downstream ops read stale coords."""
    world = config["mc"]["world"]
    rcon.batch([
        "give Tester minecraft:cobblestone 32",
        # Tp to (2.5, 64, 2.5) — full-block start (stone underfoot at y=63).
        f"execute in {world} run tp Tester 2.5 {ARENA_Y_STAND} 2.5 0 0",
    ])
    time.sleep(1.5)
    before = bot.position() or {}
    assert before.get("y", 0) == ARENA_Y_STAND, f"bot should start at y={ARENA_Y_STAND}, got {before}"

    r = bot.post("/action/pillar_step", {"count": 3}, timeout=45)
    assert r.get("ok"), r
    placed = r.get("placed", 0)
    assert placed == 3, f"expected 3 placements on flat-ground start, got {placed}: {r}"

    # Report's startY/endY contract.
    start_y = r.get("startY")
    end_y = r.get("endY")
    assert end_y - start_y == placed, (
        f"endY-startY ({end_y - start_y}) must equal placed ({placed}): {r}"
    )

    # Settle a beat for position packets to land, then verify /status
    # agrees with the report.
    time.sleep(0.5)
    after = bot.position() or {}
    assert abs(after.get("y", 0) - end_y) < 0.5, (
        f"/status Y ({after.get('y')}) does not match report endY ({end_y}). "
        f"This is the genesis 'next op reads stale position' bug. r={r}"
    )
    # x/z should also match the report (within 1 cell for fractional drift).
    rep_pos = r.get("position") or {}
    assert abs(after.get("x", 0) - rep_pos.get("x", 0)) < 1.5, (
        f"x drift: status={after}, report={rep_pos}"
    )
    assert abs(after.get("z", 0) - rep_pos.get("z", 0)) < 1.5, (
        f"z drift: status={after}, report={rep_pos}"
    )


# ─── C. pillar_down position snapshot pre-pickup ─────────────────────────

@pytest.mark.functional
def test_pillar_down_position_is_pre_pickup_landing(bot, rcon, config, state_arena, arena):
    """pillar_down's reported `position` must be the pillar's ENDING
    landing — NOT where the post-action pickup pathed to grab drops.

    Setup: solid stone column under (4, 60..63, 4). Bot at (4, 64, 4).
    Spawn a cobblestone drop at (-3, 64, -3) — far enough that pickup
    MUST pathfind to it. If the snapshot is broken, r['position'] will
    show ≈(-3,Y,-3) instead of (4,Y,4)."""
    world = config["mc"]["world"]
    rcon.batch([
        # Stone column already exists from the arena fixture (full floor).
        # Bot at (4.5, 64, 4.5).
        "give Tester minecraft:iron_pickaxe 1",
        "give Tester minecraft:cobblestone 32",
        f"execute in {world} run tp Tester 4.5 {ARENA_Y_STAND} 4.5 0 0",
        # Spawn a drop laterally so pickup MUST move the bot.
        f"execute in {world} run summon item -3 {ARENA_Y_STAND} -3 "
        f'{{Item:{{id:"minecraft:cobblestone",count:1}},'
        f"PickupDelay:0,Age:0,Motion:[0d,0d,0d]}}",
    ])
    arena.settle_default()
    before = bot.position() or {}
    assert abs(before.get("x", 0) - 4.5) < 0.5, f"bot should start at x=4.5, got {before}"

    r = bot.post("/action/pillar_down", {"count": 2, "pickup": True}, timeout=45)
    assert r.get("ok") is not False, f"unexpected refusal: {r}"
    dug = r.get("dug", 0)
    assert dug >= 1, f"expected at least 1 dig, got {dug}: {r}"

    # The key assertion: report's `position` shows the PILLAR-DOWN landing
    # (at x=4, z=4), NOT the pickup destination (near -3, -3).
    rep_pos = r.get("position") or {}
    assert rep_pos.get("x") == 4, (
        f"report.position.x must be the pillar landing (4), got {rep_pos.get('x')}. "
        f"If this is near -3, the pickup-pathing leaked into the report — "
        f"the snapshot-before-pickup fix was bypassed or reverted. r={r}"
    )
    assert rep_pos.get("z") == 4, (
        f"report.position.z must be the pillar landing (4), got {rep_pos.get('z')}: {r}"
    )

    # /status MAY show the bot near (-3, ?, -3) after pickup pathed it
    # there — that's expected divergence between r.position (pre-pickup)
    # and /status (post-pickup). Don't assert equality; the whole point
    # of this test is they ARE allowed to differ.
    after = bot.position() or {}
    # Sanity: SOMETHING happened — either bot is at pillar landing OR
    # at the drop's vicinity. Just ensure /status reads aren't garbage.
    assert "y" in after, f"/status returned empty position: {after}"


# ─── D. Move → pillar → check sequencing ────────────────────────────────

@pytest.mark.functional
def test_move_pillar_chain_position_consistency(bot, rcon, config, state_arena):
    """The exact symptom from the genesis run: chain ops and verify each
    next-op's preflight read of /status matches the previous op's reported
    position. If it doesn't, the next op picks the wrong reference cell."""
    world = config["mc"]["world"]
    rcon.batch([
        "give Tester minecraft:cobblestone 32",
        # Pickaxe so step 3's pillar_down can break the cobblestone the
        # previous pillar_step placed.
        "give Tester minecraft:iron_pickaxe 1",
        f"execute in {world} run tp Tester 0.5 {ARENA_Y_STAND} 0.5 0 0",
    ])
    time.sleep(1.5)

    # Step 1: move to (3, 64, 3). Verify /status matches what we asked for.
    r1 = bot.post(
        "/action/move",
        {"x": 3, "y": ARENA_Y_STAND, "z": 3, "max_doors": 0},
        timeout=30,
    )
    assert r1.get("ok") is not False, f"move failed: {r1}"
    time.sleep(0.4)
    after1 = bot.position() or {}
    assert abs(after1.get("x", 99) - 3.5) < 1.0 and abs(after1.get("z", 99) - 3.5) < 1.0, (
        f"after mc move to (3, 64, 3), /status should read ≈(3.5, 64, 3.5), got {after1}: r1={r1}"
    )

    # Step 2: pillar_step count=2. Verify the report's endY matches
    # /status post-settle.
    r2 = bot.post("/action/pillar_step", {"count": 2}, timeout=45)
    assert r2.get("ok"), r2
    placed = r2.get("placed", 0)
    assert placed == 2, f"expected placed=2 on flat ground, got {placed}: {r2}"
    end_y_2 = r2.get("endY")
    time.sleep(0.5)
    after2 = bot.position() or {}
    assert abs(after2.get("y", 0) - end_y_2) < 0.5, (
        f"after pillar_step, /status.y ({after2.get('y')}) should match report endY ({end_y_2}). "
        f"Stale read here = downstream ops use wrong reference. r2={r2}"
    )

    # Step 3: pillar_down count=1. Same invariant in the other direction.
    r3 = bot.post("/action/pillar_down", {"count": 1, "pickup": False}, timeout=30)
    assert r3.get("ok") is not False, f"pillar_down failed: {r3}"
    dug = r3.get("dug", 0)
    assert dug == 1, f"expected dug=1, got {dug}: {r3}"
    end_y_3 = r3.get("endY")
    time.sleep(0.5)
    after3 = bot.position() or {}
    assert abs(after3.get("y", 0) - end_y_3) < 0.5, (
        f"after pillar_down, /status.y ({after3.get('y')}) should match report endY ({end_y_3}). "
        f"r3={r3}"
    )
    # And the Y delta should equal placed/dug from r2/r3 combined:
    # rose +2, descended -1, net +1 vs starting y=64.
    assert abs(after3.get("y", 0) - (ARENA_Y_STAND + placed - dug)) < 0.5, (
        f"net Y delta wrong after chain: start={ARENA_Y_STAND}, +{placed} pillared, -{dug} dug. "
        f"Expected ≈{ARENA_Y_STAND + placed - dug}, got /status={after3}"
    )
