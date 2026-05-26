"""Regression test for the underground-door NAV_BLOCKED storm.

Reproduces the 2026-05-26 hut1-supply failure mode where bots
repeatedly picked an underground rescue door at (370,59,-591) when
routing toward a surface target at Y=65. Two bugs interacted:

  (A) `findBestDoor` had no pathfind precheck — distant unreachable
      underground doors were chosen because their `far_side` was
      geometrically closer to the target than the bot was.

  (B) `computeDoorSides` used `target.y` instead of `door.y` for both
      sides. When the door was 6 below surface, `mc through`'s lookAt
      pitched the bot up; `setControlState('forward')` produced almost
      no XZ movement and the bot stalled touching the doorframe.
      Canonical log signature observed 26 times in production:

          Opened oak_door but bot stalled at 365.3,51.0,-589.3
          (target 368,65,-591)

Two scenarios:

  - **NEAR**: bot near an underground door, surface target on the far
    side. With fix (B), `mc through` walks horizontally through the
    door and the bot ends up past it.

  - **FAR**: bot far from the underground door, surface target also
    distant. With fix (A), the connectivity precheck filters the
    unreachable door out of `findBestDoor`; `mc move` surfaces a clean
    "no door/gate between to use" error and suggests `mc tunnel` /
    `mc dig_area`, instead of wasting 8-30s pathfinding to an
    unreachable door.

Pre-fix expected behaviors (kept here for reference, NOT run as
asserts):

  - NEAR: bot ends stuck at z≈doorZ+1 with "Opened door but stalled"
    in `result`.
  - FAR: bot logs "Could not approach gate at (370,59,-591)" after
    ~8-30s reach cap.
"""

from __future__ import annotations

import time

import pytest

# `time` is imported for the elapsed-time assertion in
# test_move_skips_unreachable_underground_door (we measure how long the
# precheck takes). All settle waits use arena.settle_*() per harness
# convention.


@pytest.fixture
def underground_door_arena(rcon, arena, tester_bot, config):
    """Build the underground-door reproduction arena.

    Surface layout (y=65 plane, looking down with -Z north and +Z south):

        z=-5  bot start (5, 65, -5)
        z=-1  SURFACE WALL — stone at x∈[3,7], y=65..70 (6 tall, no
              parkour route over it)
        z=+5  TARGET (5, 65, 5)

    Underground tunnel (y=58..60, x=5 — 1-block-wide N/S corridor):

        z=-5..-1   air (south chamber half)
        z=0        oak_door at (5,59,0) facing south, lower+upper halves
        z=+1..+5   air (north chamber half)

    The underground tunnel is sealed in stone (no shaft, no entrance
    from the surface). `b.findBlocks` will surface the door because
    it's within 64 blocks of any bot on the surface, but
    `pathfinder.getPathTo(near_side)` cannot route there without
    digging. Pre-fix-B (no connectivity precheck), `findBestDoor`
    would pick this door and waste 8-30s of the reach cap; post-fix
    it's filtered out and `mc move` surfaces the clean "no door/gate
    between to use" error in <2s.

    For test 2 we TP the bot directly INTO the tunnel so it has LOS
    to the door, then exercise `mc through` with destination at the
    door's own Y — pre-fix-A would have used `target.y` (a surface
    altitude); post-fix uses `door.y` so the walk vector stays
    horizontal.
    """
    world = config["mc"]["world"]
    arena.forceload((-1, -1, 1, 1))
    # Clear the working volume.
    rcon.batch([
        f"execute in {world} run fill -15 55 -15 15 80 15 minecraft:air",
        f"execute in {world} run fill -15 55 -15 15 63 15 minecraft:stone",
        f"execute in {world} run fill -15 64 -15 15 64 15 minecraft:grass_block",
    ])
    # Carve the underground tunnel: 1-wide along x=5, y=58..60, z∈[-5,5].
    # Tunnel floor stays as the natural stone at y=57.
    rcon.batch([
        f"execute in {world} run fill 5 58 -5 5 60 5 minecraft:air",
    ])
    # Place the door at (5,59,0) facing south. The corresponding
    # facing makes its open-axis aligned with bot travel direction
    # (we test the bot walking south→north and north→south through it).
    rcon.batch([
        f"execute in {world} run setblock 5 59 0 minecraft:oak_door[half=lower,facing=south,hinge=left,open=false]",
        f"execute in {world} run setblock 5 60 0 minecraft:oak_door[half=upper,facing=south,hinge=left,open=false]",
    ])
    # Build a fully enclosed test pen so pathfinder can't route around
    # surface obstructions. The bot starts in the southern half; the
    # target sits in the northern half; a 6-tall stone wall at z=-1
    # divides them. The only "passable" block in the entire pen is the
    # underground door, but the door's chamber is sealed (no shaft to
    # surface) — so the connectivity precheck must filter it out.
    pen_x_min, pen_x_max = -7, 8   # inner walkable width 14 (x=-6..7)
    pen_z_min, pen_z_max = -10, 10
    pen_y_top = 70                  # 6-block-tall walls
    rcon.batch([
        # West wall
        f"execute in {world} run fill {pen_x_min} 65 {pen_z_min} {pen_x_min} {pen_y_top} {pen_z_max} minecraft:stone",
        # East wall
        f"execute in {world} run fill {pen_x_max} 65 {pen_z_min} {pen_x_max} {pen_y_top} {pen_z_max} minecraft:stone",
        # South wall
        f"execute in {world} run fill {pen_x_min} 65 {pen_z_min} {pen_x_max} {pen_y_top} {pen_z_min} minecraft:stone",
        # North wall
        f"execute in {world} run fill {pen_x_min} 65 {pen_z_max} {pen_x_max} {pen_y_top} {pen_z_max} minecraft:stone",
        # Internal divider at z=-1 (between bot start z=-5 and target z=5)
        f"execute in {world} run fill {pen_x_min} 65 -1 {pen_x_max} {pen_y_top} -1 minecraft:stone",
        # Ceiling so the bot can't try to jump out
        f"execute in {world} run fill {pen_x_min} {pen_y_top + 1} {pen_z_min} {pen_x_max} {pen_y_top + 1} {pen_z_max} minecraft:stone",
    ])
    rcon.batch([
        "effect give Tester minecraft:resistance 600 4",
        "effect give Tester minecraft:saturation 600 1",
        "clear Tester",
    ])
    arena.settle_default()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.run(f"execute in {world} run fill -15 55 -15 15 80 15 minecraft:air")
    arena.forceload_remove_all()


@pytest.mark.functional
def test_move_skips_unreachable_underground_door(bot, rcon, config, arena, underground_door_arena):
    """Bot on the surface at (5,65,-4), target on the surface at (5,65,2).

    The only registered "passable" block between them is an underground
    door at (5,59,-2), but it's encased in stone — pathfinder can't
    reach it from the surface. With fix B (connectivity precheck),
    `findBestDoor` filters this candidate out and `mc move` surfaces a
    clean "no door/gate between to use" error in <5s instead of wasting
    the full 25-30s door-approach cap.
    """
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run tp Tester 5 65 -5 0 0")
    arena.settle_default()
    t0 = time.time()
    r = bot.post("/action/move", {"x": 5, "y": 65, "z": 5}, timeout=15)
    elapsed = time.time() - t0

    # The bot SHOULD fail (no surface route exists in this arena), but
    # the failure must NOT cite the underground door as the failed
    # approach. With the precheck, findBestDoor returns null and the
    # error is the clean "no door/gate" form.
    assert r.get("ok") is False, f"expected failure (no surface path); got {r}"
    err = r.get("error", {})
    msg = (err.get("message") or "").lower()
    # The precheck shouldn't have wasted the full approach cap.
    assert elapsed < 8.0, (
        f"connectivity precheck should fail fast (<8s); took {elapsed:.1f}s. "
        f"Suggests the door precheck regressed and the bot wasted the reach cap. r={r}"
    )
    # The error should NOT mention the unreachable underground door.
    assert "5,59,0" not in msg and "5, 59, 0" not in msg, (
        f"With the connectivity precheck the underground door should be "
        f"filtered, but the error still cites it: {msg!r}"
    )


@pytest.mark.functional
def test_through_an_underground_door_uses_door_y(bot, rcon, config, arena, underground_door_arena):
    """Direct `mc through` call against the underground door — when the
    bot is positioned at the door's near-side underground, traversal
    must succeed with the door's Y (not a surface target Y).

    Replicates fix A in isolation: TP the bot into the chamber at the
    near side, call `/action/through` with explicit gx/gy/gz and
    dx/dy/dz at the DOOR's Y, and verify the bot crosses.

    A pre-fix run with `dy=65` (target Y above surface) would lookAt
    upward and stall — this is the smoking-gun bug we're guarding
    against in `computeDoorSides`.
    """
    world = config["mc"]["world"]
    # TP bot into the south end of the tunnel, 3 south of the door at z=0,
    # facing north so it has LOS to the door cell.
    rcon.run(f"execute in {world} run tp Tester 5 59 3 180 0")
    arena.settle_default()

    # Call mc through with dest at the door's Y (fix A: door.y, NOT
    # some surface target Y like 65). Bot should open + walk forward
    # and end up past the door (z < 0).
    r = bot.post("/action/through", {
        "gx": 5, "gy": 59, "gz": 0,
        "dx": 5, "dy": 59, "dz": -3,
    }, timeout=15)
    pos = bot.position()
    assert pos.get("z", 99) < 0.0, (
        f"bot must cross north past door (z < 0); ok={r.get('ok')} "
        f"pos={pos} r={r}"
    )
