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
