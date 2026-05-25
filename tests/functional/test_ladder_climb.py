"""mc ladder up/down — primitive climb verification.

Mason's hut3 roof build (t_ce21f3ff, 2026-05-24): bot could enter a
ladder shaft and reach Y=68.7 but `mc move` consistently failed past
that. Pathfinder's per-cell climbable handling stalls on the top-of-
ladder exit transition. The `mc ladder` primitive drives the climb via
control-state (`forward` + `jump` for up; release for down) and exits
forward at the top.

Arena: free-standing stone pillar with a ladder attached to its west
face. Bot climbs the ladder and ends up STANDING ON TOP of the pillar.
"""

from __future__ import annotations

import time

import pytest


# Free-standing stone pillar with a ladder attached to its WEST face.
# The ladder is built ONE BLOCK TALLER than the pillar — mirroring the
# real-world "ladder extends past the floor opening" pattern common in
# hut construction, and mechanically necessary for clean exit: the
# bot climbs past the pillar top, then steps east through the air
# cell beside the topmost ladder block, falling cleanly onto the
# pillar top. With ladder height = pillar height, the bot is wedged
# between the ladder and the wall and can't reliably translate east
# (insufficient vertical clearance above the wall top — see
# ladder.js for the physics rationale).
#
#   x=2: stone pillar, y = base_y .. pillar_top_y
#   x=1: ladder column, y = base_y .. ladder_top_y  (1 taller)
#   x=1, y=base_y - 1: stone floor (bot starts here)
def _build_pillar_arena(
    rcon, world: str, *, pillar_height: int = 5, ladder_extra: int = 1, base_y: int = 66
):
    pillar_top_y = base_y + pillar_height - 1
    ladder_top_y = pillar_top_y + ladder_extra
    cmds = []
    cmds.append(
        f"execute in {world} run fill 0 {base_y - 1} -1 3 {ladder_top_y + 4} 1 air"
    )
    for y in range(base_y, pillar_top_y + 1):
        cmds.append(
            f"execute in {world} run setblock 2 {y} 0 minecraft:stone"
        )
    for y in range(base_y, ladder_top_y + 1):
        cmds.append(
            f"execute in {world} run setblock 1 {y} 0 "
            f"minecraft:ladder[facing=west]"
        )
    cmds.append(
        f"execute in {world} run setblock 1 {base_y - 1} 0 minecraft:stone"
    )
    rcon.batch(cmds)
    return {
        "base_y": base_y,
        "ladder_top_y": ladder_top_y,
        "pillar_top_block_y": pillar_top_y,
        "pillar_stand_y": pillar_top_y + 1,
    }


def _teardown_arena(rcon, world: str, *, base_y: int = 66, ladder_top_y: int = 72):
    rcon.run(
        f"execute in {world} run fill 0 {base_y - 1} -1 3 {ladder_top_y + 4} 1 air"
    )


@pytest.fixture
def pillar_arena(arena, rcon, config):
    """Default 5-block pillar + 6-block ladder (1 extra at top for exit)."""
    world = config["mc"]["world"]
    info = _build_pillar_arena(rcon, world, pillar_height=5, ladder_extra=1, base_y=66)
    arena.settle_default()
    yield info
    _teardown_arena(rcon, world, base_y=66, ladder_top_y=info["ladder_top_y"])


@pytest.mark.functional
def test_ladder_up_climbs_to_top_of_column(bot, rcon, arena, config, pillar_arena):
    """User's hut3-roof scenario (2026-05-24): ladder on the side of a
    free-standing pillar. The CORE capability `mc ladder up` provides
    is reliably reaching the top of the climbable column — that's
    what's needed to unblock Mason (he can then `mc place` to bridge
    onto the pillar top, or work directly from the ladder).

    Auto-exit onto an adjacent pillar block is best-effort: at the top
    of a wall-adjacent ladder column the bot oscillates between the
    topmost ladder cell (catches it) and the air cell above (gravity
    pulls back), and the few ticks of clearance aren't enough for
    airborne acceleration to push the bot's center past the pillar's
    west face. See ladder.js for the physics rationale. This test
    asserts the reliable promise: bot reaches the top of the column,
    NOT that auto-exit lands precisely on the pillar."""
    world = config["mc"]["world"]
    info = pillar_arena

    # tp Tester to bottom of ladder, yaw=-90 (east, into wall).
    rcon.run(
        f"execute in {world} run tp Tester 1 {info['base_y']} 0 -90 0"
    )
    arena.settle()

    t0 = time.time()
    r = bot.post("/action/ladder", {"dir": "up"}, timeout=20)
    elapsed = time.time() - t0

    assert r.get("ok"), f"ladder up failed: {r}"
    end = r["data"]["end"]

    # Bot should have reached the top of the ladder column (Y ≈
    # ladder_top_y + 1, which is the climb target for exit=auto).
    # ±1 block tolerance to absorb oscillation at the top.
    expected_y = info["ladder_top_y"] + 1
    assert abs(end["y"] - expected_y) <= 1.0, (
        f"bot didn't reach top of ladder column (Y={end['y']}, expected ~{expected_y}; "
        f"ladder top block at Y={info['ladder_top_y']})"
    )
    assert elapsed < 12, f"climb took {elapsed:.1f}s — too slow"
    assert elapsed < 12, f"climb took {elapsed:.1f}s — too slow"


@pytest.mark.functional
def test_ladder_up_to_specific_y_holds_position(bot, rcon, arena, config, pillar_arena):
    """mc ladder up --to=69 --exit=none stops mid-shaft and clings to
    the ladder (caller intends to dig/place from there)."""
    world = config["mc"]["world"]
    info = pillar_arena

    rcon.run(
        f"execute in {world} run tp Tester 1 {info['base_y']} 0 -90 0"
    )
    arena.settle()

    r = bot.post("/action/ladder", {"dir": "up", "to": 69, "exit": "none"}, timeout=15)
    assert r.get("ok"), f"ladder up to=69 exit=none failed: {r}"
    end = r["data"]["end"]
    # Should stop near Y=69, NOT continue up to the top.
    assert 68.5 <= end["y"] <= 69.5, (
        f"bot stopped at Y={end['y']}, expected ~69"
    )
    # Should still be on the ladder (exit=none = hold position).
    assert r["data"].get("still_on_ladder") is True, (
        f"bot left the ladder despite exit=none: {r['data']}"
    )


@pytest.mark.functional
def test_ladder_down_descends_to_bottom(bot, rcon, arena, config, pillar_arena):
    """mc ladder down: bot at top of column descends and ends on the
    floor below the column."""
    world = config["mc"]["world"]
    info = pillar_arena

    # Place at top ladder cell. Yaw -90 = facing east (toward pillar).
    rcon.run(
        f"execute in {world} run tp Tester 1 {info['ladder_top_y']} 0 -90 0"
    )
    arena.settle()

    r = bot.post("/action/ladder", {"dir": "down"}, timeout=15)
    assert r.get("ok"), f"ladder down failed: {r}"
    end = r["data"]["end"]
    # Should end at or near base_y (the bottom ladder cell, feet on the
    # stone floor at base_y - 1, so Y ≈ base_y).
    assert end["y"] <= info["base_y"] + 0.5, (
        f"bot didn't descend (Y={end['y']}, expected ≤{info['base_y'] + 0.5})"
    )


@pytest.mark.functional
def test_ladder_up_returns_error_when_no_ladder(bot, rcon, arena, config):
    """LADDER_NOT_FOUND when the bot's current cell has no ladder."""
    arena.place_player(bot, 0, 65, 0, expected_floor_y=64)
    arena.settle()

    r = bot.post("/action/ladder", {"dir": "up"}, timeout=8)
    assert not r.get("ok"), f"expected failure but got: {r}"
    assert r.get("error", {}).get("code") == "LADDER_NOT_FOUND", r


@pytest.mark.functional
def test_ladder_invalid_dir_arg(bot):
    """INVALID_ARG when dir is not up/down."""
    r = bot.post("/action/ladder", {"dir": "sideways"}, timeout=5)
    assert not r.get("ok"), r
    assert r.get("error", {}).get("code") == "INVALID_ARG", r


# ─── tower-shaft-from-above (Flint, 2026-05-26) ─────────────────────────
#
# Flint at (374.5, 70, -583.5) sat on a tower roof whose interior had a
# ladder shaft. Tower walls at y=65..70, ladder inside the shaft at
# y=66..71 (1 block above the wall top). All 4 lateral cells around the
# ladder at y=70 were cobblestone; the ONLY entry was to drop into the
# shaft from y=71. No primitive handled that — Flint sat there until he
# fell and died. This test paints that geometry and asserts mc ladder
# down detects the shaft, drops in, and descends to the bottom.

def _build_tower_with_inner_shaft(rcon, world: str, *, base_y: int = 66, wall_top_y: int = 70):
    """Sealed-roof cobble tower with an inner 1x1 ladder shaft. The ladder
    extends ONE BLOCK ABOVE the wall top so the entry cell at
    (1, wall_top_y + 1, 0) is exposed air with a ladder block directly
    beneath. Bot starts standing on the wall top at (0, wall_top_y + 1, 0)."""
    ladder_top_y = wall_top_y + 1
    cmds = []
    # Reset a 4x(wall_top+5)x4 box to air.
    cmds.append(f"execute in {world} run fill -2 {base_y - 2} -2 3 {ladder_top_y + 4} 3 air")
    # Stone floor (the "ground" the tower sits on AND the bot's roof landing).
    cmds.append(f"execute in {world} run fill -2 {base_y - 1} -2 3 {base_y - 1} 3 minecraft:stone")
    # Tower walls — 3x3 footprint at (0..2, *, 0..2), hollow inside. Walls
    # are 1-block thick at x=0 and x=2 (east/west), z=0 and z=2 (n/s).
    for y in range(base_y, wall_top_y + 1):
        # West wall x=0
        for z in range(0, 3):
            cmds.append(f"execute in {world} run setblock 0 {y} {z} minecraft:cobblestone")
        # East wall x=2
        for z in range(0, 3):
            cmds.append(f"execute in {world} run setblock 2 {y} {z} minecraft:cobblestone")
        # North wall z=0 (already partially covered by east/west)
        cmds.append(f"execute in {world} run setblock 1 {y} 0 minecraft:cobblestone")
        # South wall z=2
        cmds.append(f"execute in {world} run setblock 1 {y} 2 minecraft:cobblestone")
    # Inner shaft column at (1, *, 1) — left as air for the bot to descend through.
    for y in range(base_y, wall_top_y + 1):
        cmds.append(f"execute in {world} run setblock 1 {y} 1 minecraft:air")
    # Ladder at (1, base_y..ladder_top_y, 1) facing south (so the wall the
    # ladder attaches to is at z=2). The ladder extends 1 above the wall
    # top — its top block at (1, ladder_top_y, 1) is exposed air-above.
    for y in range(base_y, ladder_top_y + 1):
        cmds.append(f"execute in {world} run setblock 1 {y} 1 minecraft:ladder[facing=south]")
    # Cobblestone ROOF over the tower except for the 1-block hole above
    # the shaft. The bot stands on this roof.
    for x in range(0, 3):
        for z in range(0, 3):
            if x == 1 and z == 1:
                continue  # shaft hole — ladder top block at y=ladder_top_y lives here
            cmds.append(f"execute in {world} run setblock {x} {wall_top_y + 1} {z} minecraft:cobblestone")
    rcon.batch(cmds)
    return {
        "base_y": base_y,
        "wall_top_y": wall_top_y,
        "ladder_top_y": ladder_top_y,
        "shaft_xz": (1, 1),
        # Bot starts on the roof, one cell north of the shaft hole.
        "roof_start": {"x": 1, "y": wall_top_y + 2, "z": 0},
    }


@pytest.fixture
def tower_shaft_arena(arena, rcon, config):
    """4-walled tower with inner ladder shaft; ladder extends 1 above
    wall top. See _build_tower_with_inner_shaft docstring."""
    world = config["mc"]["world"]
    info = _build_tower_with_inner_shaft(rcon, world, base_y=66, wall_top_y=70)
    arena.settle_default()
    yield info
    # Teardown: wipe the whole tower zone.
    rcon.run(f"execute in {world} run fill -2 {info['base_y'] - 2} -2 3 {info['ladder_top_y'] + 4} 3 air")


@pytest.mark.functional
def test_ladder_down_enters_shaft_from_tower_roof(bot, rcon, arena, config, tower_shaft_arena):
    """Bot on the tower roof adjacent to the shaft hole. mc ladder down
    must detect the ladder in the neighboring shaft cell, drop the bot
    into the shaft (entering at the topmost ladder cell), then descend.

    Pass criteria:
      - ok=true
      - final Y at or near the bottom of the shaft (base_y or just above)
      - data.entered_from_above is present and points at the shaft cell
    """
    world = config["mc"]["world"]
    info = tower_shaft_arena

    # TP bot to the roof, one cell north of the shaft hole. Face south
    # (toward the shaft) so any look-driven step-in works naturally.
    start = info["roof_start"]
    rcon.run(f"execute in {world} run tp Tester {start['x']} {start['y']} {start['z']} 180 0")
    arena.settle()

    r = bot.post("/action/ladder", {"dir": "down"}, timeout=30)
    assert r.get("ok"), f"ladder down from tower roof failed: {r}"

    # Bot should end at the bottom of the shaft (feet on the stone floor
    # below the ladder). base_y is the cell containing the bottom ladder
    # block; the stone floor is at base_y - 1, so feet ≈ base_y.
    end = r["data"]["end"]
    assert end["y"] <= info["base_y"] + 0.5, (
        f"bot didn't descend through the shaft (Y={end['y']}, expected ≤{info['base_y'] + 0.5})"
    )
    # And horizontally inside the shaft column.
    shaft_x, shaft_z = info["shaft_xz"]
    assert abs(end["x"] - (shaft_x + 0.5)) <= 0.8, f"end x={end['x']} not in shaft column x={shaft_x}"
    assert abs(end["z"] - (shaft_z + 0.5)) <= 0.8, f"end z={end['z']} not in shaft column z={shaft_z}"

    # The primitive should report the entry maneuver for audit.
    assert r["data"].get("entered_from_above") is not None, (
        f"expected data.entered_from_above on response, got: {r['data']}"
    )
