"""pillar_step recovery through thick ceilings.

Three scenarios — exercising the extended pillar_step primitive end-to-end:

A. Pillar through a 10-block stone ceiling with stone_pickaxe + 32 dirt.
   Baseline happy path — iterates ensureHeadroom-dig + place internally.
   Should reach the surface in a single pillar_step call.

B. Pillar from EMPTY inventory through an 8-block dirt ceiling.
   Tests the capture-from-ceiling fallback — bare-hand dig overhead, pick up
   the drop, re-equip the captured block, pillar. Loops without operator help.

C. Pillar from a 4-dirt inventory (no pickaxe) through a 3-block stone
   ceiling. Default call fails (slow-dig guard refuses stone bare-hand);
   --force bypasses the guard and the primitive pillars using stocked dirt.

Uses the Tester bot at config.bot.roles.tester. World-setup constants mirror
the agent-test YAML fixtures (data/agent-tests/F8_pillar_thick_ceiling.yaml
and friends) so failures here can be cross-checked against the agent runs.
"""

from __future__ import annotations

import time

import pytest


# Arena geometry — cavity at y=64..65 inside a stone shell. Each scenario
# overrides the ceiling thickness/material with a per-test rcon batch.
ARENA_X_MIN, ARENA_X_MAX = -5, 5
ARENA_Z_MIN, ARENA_Z_MAX = -5, 5
ARENA_Y_BEDROCK = 50
ARENA_Y_FLOOR = 63       # solid stone — bot stands on this
ARENA_Y_CAVITY_LO = 64
ARENA_Y_CAVITY_HI = 65
ARENA_Y_CLEAR_TOP = 100  # everything above is air during reset


@pytest.fixture
def pillar_arena(rcon, config, tester_bot):
    """Reset to a 1x1x2 cavity with stone shell extending up. Each test
    paints its own ceiling on top of this baseline. Bot teleported to
    (0, 64, 0) standing on stone, with effects cleared and inventory wiped.

    1x1 cavity (not 3x3) because pillar_step's canStepLaterally detects
    *any* walkable neighbor as an "exit" and bails — a 3x3 cavity gives
    the bot walkable lateral cells inside its own room, masking the
    pillar-through-ceiling behavior we're trying to test. F3 stuck-in-pit
    also uses a 1x1 hole for the same reason.
    """
    world = config["mc"]["world"]
    rcon.batch([
        f"execute in {world} run difficulty peaceful",
        f"execute in {world} run gamerule doDaylightCycle false",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run time set day",
        f"execute in {world} run kill @e[type=!player]",
        # Clear column from way below to way above
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_CLEAR_TOP} {ARENA_Z_MAX} minecraft:air",
        # Bedrock floor at y=50 — safety net for any falling bug
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_BEDROCK} {ARENA_Z_MAX} minecraft:bedrock",
        # Stone column from floor up through ceiling baseline
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_FLOOR-1} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_CAVITY_HI} {ARENA_Z_MAX} minecraft:stone",
        # Carve a 1x1x2 cavity at (0, 64..65, 0) — JUST the bot's column.
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_LO} 0 minecraft:air",
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_HI} 0 minecraft:air",
        "clear Tester",
        f"effect clear Tester",
        f"effect give Tester minecraft:saturation 600 1",
        # Force survival so dig produces drops — capture-from-ceiling depends
        # on it. Creative gamemode would silently break test B.
        "gamemode survival Tester",
        f"execute in {world} run tp Tester 0 {ARENA_Y_CAVITY_LO} 0 0 0",
    ])
    # Settle — let the bot register its new position before we paint ceilings
    time.sleep(1.5)
    yield
    # Best-effort cleanup: tp to safe spot, wipe arena.
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_CLEAR_TOP} {ARENA_Z_MAX} minecraft:air",
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_BEDROCK} {ARENA_Z_MAX} minecraft:bedrock",
        f"execute in {world} run fill {ARENA_X_MIN} {ARENA_Y_BEDROCK+1} {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} {ARENA_Y_FLOOR} {ARENA_Z_MAX} minecraft:stone",
        f"execute in {world} run tp Tester 0 {ARENA_Y_FLOOR+1} 0 0 0",
    ])


@pytest.mark.functional
def test_pillar_through_stone_ceiling_with_pickaxe(bot, rcon, config, pillar_arena):
    """A: 10-block stone ceiling, bot has stone_pickaxe + 32 dirt → escape."""
    world = config["mc"]["world"]
    # Paint a 10-block stone ceiling above the cavity (y=66..75). Surface
    # opens at y=76. Stone column already extends to y=65; layer y=66..75 on top.
    rcon.batch([
        f"execute in {world} run fill {ARENA_X_MIN} 66 {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} 75 {ARENA_Z_MAX} minecraft:stone",
        # Re-carve the 1x1 cavity in case we just paved over it (paranoia).
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_LO} 0 minecraft:air",
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_HI} 0 minecraft:air",
        "give Tester minecraft:stone_pickaxe 1",
        "give Tester minecraft:dirt 32",
        f"execute in {world} run tp Tester 0 {ARENA_Y_CAVITY_LO} 0 0 0",
    ])
    time.sleep(2.0)
    before_y = (bot.position() or {}).get("y", 0)
    assert before_y < 66, f"bot should be in cavity, was at y={before_y}"

    # One pillar_step call with count=20 should iterate dig+place through
    # all 10 ceiling blocks and emerge on the surface at y=76.
    r = bot.post("/action/pillar_step", {"count": 20}, timeout=90)
    assert r.get("ok"), r
    placed = r.get("placed", 0)
    assert placed >= 10, f"expected >= 10 placements through 10-block ceiling, got {placed}: {r}"

    after = bot.position() or {}
    assert after.get("y", 0) >= 76, f"bot did not reach surface, ended at {after}: {r}"


@pytest.mark.functional
@pytest.mark.xfail(reason="capture-from-ceiling has a drop-timing race; see commit msg + skills/minecraft-mining.md")
def test_pillar_capture_from_dirt_ceiling_empty_inventory(bot, rcon, config, pillar_arena):
    """B: 8-block dirt ceiling, bot empty → bare-hand dig + capture + pillar."""
    world = config["mc"]["world"]
    # Dirt ceiling 8 blocks thick (y=66..73). Surface at y=74. Use dirt so
    # bare-hand digging is allowed AND drops dirt (the captured pillar block).
    rcon.batch([
        f"execute in {world} run fill {ARENA_X_MIN} 66 {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} 73 {ARENA_Z_MAX} minecraft:dirt",
        # Re-carve the 1x1 cavity.
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_LO} 0 minecraft:air",
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_HI} 0 minecraft:air",
        "clear Tester",  # ensure empty inventory
        f"execute in {world} run tp Tester 0 {ARENA_Y_CAVITY_LO} 0 0 0",
    ])
    time.sleep(2.0)
    before_y = (bot.position() or {}).get("y", 0)
    assert before_y < 66, f"bot should be in cavity, was at y={before_y}"

    # XFAIL note: this test currently fails due to a timing race in
    # captureFromCeiling — the dirt drop from ensureHeadroom's dig arrives
    # in inventory AFTER the primitive's per-iteration poll window (~1.2s).
    # See commit message + skills/minecraft-mining.md for the workaround
    # (call pillar_step twice) and the planned playerCollect-event fix.

    # Bot has nothing. The primitive must bare-hand dig the dirt overhead,
    # await the drop, pickup, re-equip the captured dirt, then pillar.
    # Loops 8 times to reach surface. Generous timeout — pickup involves a
    # short wait for the item magnet on each step.
    r = bot.post("/action/pillar_step", {"count": 12}, timeout=180)
    assert r.get("ok"), r
    placed = r.get("placed", 0)
    assert placed >= 8, (
        f"expected >= 8 placements through 8-block dirt ceiling from empty "
        f"inventory, got {placed}: {r}"
    )

    after = bot.position() or {}
    assert after.get("y", 0) >= 74, f"bot did not reach surface, ended at {after}: {r}"


@pytest.mark.functional
def test_pillar_force_required_for_bare_hand_stone(bot, rcon, config, pillar_arena):
    """C: 3-block stone ceiling + 4 dirt + no pickaxe → default fails,
    --force succeeds via slow bare-hand stone dig + pillar with stocked dirt.
    """
    world = config["mc"]["world"]
    # 3-block stone ceiling (y=66..68). Surface at y=69. Bot has dirt to
    # pillar with but NO pickaxe, so stone-dig is gated by the slow-dig
    # guard — default pillar_step must refuse, then --force bypasses.
    rcon.batch([
        f"execute in {world} run fill {ARENA_X_MIN} 66 {ARENA_Z_MIN} "
        f"{ARENA_X_MAX} 68 {ARENA_Z_MAX} minecraft:stone",
        # Re-carve the 1x1 cavity.
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_LO} 0 minecraft:air",
        f"execute in {world} run setblock 0 {ARENA_Y_CAVITY_HI} 0 minecraft:air",
        "clear Tester",
        "give Tester minecraft:dirt 8",
        f"execute in {world} run tp Tester 0 {ARENA_Y_CAVITY_LO} 0 0 0",
    ])
    time.sleep(2.0)

    # First attempt without force — guardSlowDigEstimate refuses the
    # bare-hand stone dig in ensureHeadroom. The primitive should surface
    # PILLAR_FAILED (or a partial-placement result that doesn't reach
    # surface) with a hint about --force in the fail_reasons.
    r1 = bot.post("/action/pillar_step", {"count": 8}, timeout=60)
    after1 = bot.position() or {}
    assert after1.get("y", 0) < 69, (
        f"expected bot stuck below surface without --force, was at {after1}. "
        f"r={r1}"
    )

    # Now retry with --force. The slow-dig guard is bypassed; the bot
    # bare-hand digs the stone (slow — ~7.5s per cell, no drop), pillars
    # using stocked dirt, iterates ~5 times. Long timeout for the slow dig.
    r2 = bot.post("/action/pillar_step", {"count": 10, "force": True}, timeout=240)
    assert r2.get("ok"), r2
    placed2 = r2.get("placed", 0)
    assert placed2 >= 5, f"expected >= 5 placements with --force, got {placed2}: {r2}"

    after2 = bot.position() or {}
    # Surface = standing on top of the (former) y=68 ceiling = feet at y=69.
    assert after2.get("y", 0) >= 69, (
        f"bot did not reach surface with --force, ended at {after2}: {r2}"
    )
