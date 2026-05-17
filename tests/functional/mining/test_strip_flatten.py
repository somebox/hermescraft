"""Strip-mine 32 blocks from a 16×16×3 dirt pit + scatter on top.

Realistic scenario: a big patch of land has irregular dirt clumps on the
surface plus 3 contiguous layers of dirt below. The bot stands ON the
pile and is asked for 32 blocks. With a stone shovel, strip-mining
should:

  - Mine the bumps and clusters on top (y=67 surface clutter).
  - Mine into the top-most full layer (y=66) — the strip-mining layer.
  - **NOT touch** the two layers below (y=65, y=64).
  - Lay the mined cells out as a *linear strip* (a row or a contiguous
    cluster), not a scattered star pattern.

Geometry:

  y=67   — scattered dirt blocks + 2-3 cell clusters (the "stuff on top")
  y=66   — top of the pit (3-layer dirt), 16×16, this is the strip level
  y=65   — middle of the pit (must stay intact)
  y=64   — bottom of the pit (must stay intact)
  y=63   — stone sub-floor (untouchable for the test)

Top view (y=66 dirt extent — 16×16 footprint):

       x= 0 .. 15
   z= 0  D D D D D D D D D D D D D D D D
   z= 1  D D D D D D D D D D D D D D D D
   ...                                       (16 rows)
   z=15  D D D D D D D D D D D D D D D D

Bumps at y=67 (scatter — single cells + 2-3 cell clusters): see
SURFACE_CLUTTER. Bot starts on the pile at (2.5, 68, 2.5) — corner of
the surface, facing into the pile.

Assertions:
  1. Bot mined at least 25 cells (most of the 32-budget). Some slack
     for natural primitive failures.
  2. Middle layer (y=65) fully intact across all 256 cells.
  3. Bottom layer (y=64) fully intact across all 256 cells.
  4. Strip-pattern: mined cells at y=66 cluster in a tight bounding
     box (≤ ~3 rows OR columns, ≤ 16 cells wide). A star pattern
     would have a 16×16 footprint — strip should be much tighter.
  5. Boundary held — no cells mined OUTSIDE the 16×16 pit footprint.
  6. Bot HP unchanged.

Today's `mc collect` has no Y-boundary awareness AND its strip-sort
prioritizes Y proximity to bot; both contribute to "the bot dives once
the local pool is exhausted". XFAIL accordingly until the primitive
gets a strip-plane lock.
"""

from __future__ import annotations

import time

import pytest


# Pit footprint — 16×16 at x ∈ [0, 15], z ∈ [0, 15]. Centred near
# origin to match the existing mining-test arenas (test_mine_collect_grid,
# test_dig_walk_pickup_chain, etc.) so observers can fly to ~spawn and
# watch every test in the suite from one vantage point.
PIT_X_MIN, PIT_X_MAX = 0, 15
PIT_Z_MIN, PIT_Z_MAX = 0, 15
PIT_TOP_Y = 66      # the strip-mine target level
PIT_MIDDLE_Y = 65   # protect
PIT_BOTTOM_Y = 64   # protect
SUBFLOOR_Y = 63     # stone

# Scattered dirt blocks on top + a couple of clusters. Mix of singles
# and 2-3 cell clusters so it looks like natural detritus.
SURFACE_CLUTTER = [
    # Single bumps
    (2, 67, 5), (8, 67, 1), (13, 67, 4),
    (4, 67, 11), (10, 67, 13), (14, 67, 9),
    # 2-cell cluster
    (6, 67, 7), (7, 67, 7),
    # 3-cell cluster
    (11, 67, 2), (12, 67, 2), (12, 67, 3),
    # Another 2-cell cluster
    (1, 67, 9), (1, 67, 10),
]

BOT_TP = (2.5, 68.0, 2.5, -45, 0)   # on top of the pile corner, facing SE
VOLUME = (-5, 58, -5, 20, 72, 20)

REQUESTED_COUNT = 32
# 16×16 = 256 cells per layer. Bot has count=32. With strip-sort it
# should clear at most ~32 cells along a row+strip, well below
# the layer total.


@pytest.fixture
def pit_arena(rcon, arena, tester_bot, config):
    """Build the 16×16×3 dirt pit with the scattered surface clutter."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    # Always rescue first: peaceful + creative + safe TP. Survives any
    # prior-test crash, void-fall, or mid-respawn state.
    arena.rescue_tester(safe_xyz=(BOT_TP[0], BOT_TP[1], BOT_TP[2]), bot=tester_bot)
    arena.clean()

    x1, y1, z1, x2, y2, z2 = VOLUME
    cmds = [
        # Force-load the pit chunks. Without this the fills go into
        # unloaded chunks and silently no-op, since the bot is at the
        # default spawn area (x≈0, z≈0) when the fixture starts.
        f"execute in {world} run forceload add {x1} {z1} {x2} {z2}",
        # Clean volume + stone sub-floor.
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air",
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {SUBFLOOR_Y} {z2} minecraft:stone",
        # 16×16×3 dirt pit (bottom + middle + top, all dirt).
        f"execute in {world} run fill {PIT_X_MIN} {PIT_BOTTOM_Y} {PIT_Z_MIN} "
        f"{PIT_X_MAX} {PIT_TOP_Y} {PIT_Z_MAX} minecraft:dirt",
    ]
    # Surface clutter on y=67.
    for (cx, cy, cz) in SURFACE_CLUTTER:
        cmds.append(f"execute in {world} run setblock {cx} {cy} {cz} minecraft:dirt")
    cmds.extend([
        "clear Tester",
        "give Tester minecraft:stone_shovel",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
        # Survival + re-TP onto the pile, then heal — order matters so
        # instant_health propagates UpdateHealth with the bot stationary.
        "gamemode survival Tester",
        f"execute in {world} run tp Tester {BOT_TP[0]} {BOT_TP[1]} {BOT_TP[2]} {BOT_TP[3]} {BOT_TP[4]}",
        "effect give Tester minecraft:instant_health 1 5",
    ])
    rcon.batch(cmds)
    arena.settle(seconds=3.0)
    yield
    rcon.batch([
        "gamemode creative Tester",
        f"execute in {world} run tp Tester 0 100 0 0 0",
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air",
        f"execute in {world} run forceload remove {x1} {z1} {x2} {z2}",
    ])


@pytest.mark.functional
@pytest.mark.xfail(
    reason=(
        "Plane lock landed (depth-breach assertions #2/#3 now PASS — middle "
        "and bottom layers stay intact). Remaining failure is the strip-"
        "pattern shape (assertion #4): the bot starts ON TOP of the pit so "
        "the only cells it can initially see are its own foot block + a "
        "few clutter; mining the foot block drops the bot, then expansion "
        "happens radially in all directions (lateral LOS is symmetric), "
        "producing a roughly-square 10×10 cluster rather than a thin "
        "strip. A clean strip requires starting at the EDGE of a deposit "
        "and tunnelling inward, or a separate primitive that integrates "
        "with stair_down / tunnel. Track in follow-up — flip xfail off "
        "once mc collect produces strips when bot is positioned on a "
        "deposit edge (or once a higher-level strip-mine wrapper exists)."
    ),
    strict=False,
)
def test_strip_mine_32_keeps_lower_layers_intact(bot, rcon, arena, pit_arena):
    """Mine 32 dirt from the top two levels (clutter + y=66), leave the
    middle (y=65) and bottom (y=64) of the pit untouched. Mined cells
    should cluster as a strip, not scatter."""
    # Pre-test conditions: survival mode, on the pile, full HP.
    arena.verify_tester_ready(
        bot,
        expected_xz=(BOT_TP[0], BOT_TP[2]),
        expected_y_at_least=PIT_TOP_Y + 1,
        min_hp=17,
        xz_tol=1.5,
    )

    # Drive the mine.
    r = bot.post(
        "/action/collect",
        {"block": "dirt", "count": REQUESTED_COUNT},
        timeout=90.0,
    )

    # Diagnostic dump — gather every layer's state BEFORE asserting.
    def count_layer(y: int, kind: str) -> int:
        n = 0
        for x in range(PIT_X_MIN, PIT_X_MAX + 1):
            for z in range(PIT_Z_MIN, PIT_Z_MAX + 1):
                if rcon.block_is(x, y, z, kind):
                    n += 1
        return n

    def mined_top_cells() -> list[tuple[int, int]]:
        out = []
        for x in range(PIT_X_MIN, PIT_X_MAX + 1):
            for z in range(PIT_Z_MIN, PIT_Z_MAX + 1):
                if rcon.block_is(x, PIT_TOP_Y, z, "air"):
                    out.append((x, z))
        return out

    top_mined = mined_top_cells()
    diag = {
        "top_mined_count":          len(top_mined),
        "middle_dirt_intact":       count_layer(PIT_MIDDLE_Y, "dirt"),
        "bottom_dirt_intact":       count_layer(PIT_BOTTOM_Y, "dirt"),
        "clutter_dirt_remaining":   sum(
            1 for (cx, cy, cz) in SURFACE_CLUTTER if rcon.block_is(cx, cy, cz, "dirt")
        ),
        "response_mined_count":     (r.get("data") or {}).get("mined_count"),
        "response_causes":          (r.get("data") or {}).get("causes"),
        "response_result":          r.get("result") or r.get("error", {}).get("message"),
        "bot_pos_after":            bot.status_lean().get("position"),
    }

    # 1. Bot mined a meaningful amount (close to the 32 budget).
    response_mined = (r.get("data") or {}).get("mined_count", 0)
    assert response_mined >= 25, (
        f"bot mined too few cells: {response_mined} / {REQUESTED_COUNT}. diag={diag}"
    )

    # 2. **Middle layer (y=65) fully intact** — 256 cells of dirt.
    middle_total = (PIT_X_MAX - PIT_X_MIN + 1) * (PIT_Z_MAX - PIT_Z_MIN + 1)
    assert diag["middle_dirt_intact"] == middle_total, (
        f"DEPTH BREACH (middle): bot mined into y={PIT_MIDDLE_Y}. "
        f"Only {diag['middle_dirt_intact']}/{middle_total} cells still dirt. diag={diag}"
    )

    # 3. **Bottom layer (y=64) fully intact**.
    assert diag["bottom_dirt_intact"] == middle_total, (
        f"DEPTH BREACH (bottom): bot mined into y={PIT_BOTTOM_Y}. "
        f"Only {diag['bottom_dirt_intact']}/{middle_total} cells still dirt. diag={diag}"
    )

    # 4. **Strip pattern**: the mined cells at y=66 should occupy a
    # tight bounding box, not scatter across the 16×16. A clean strip
    # is one or two rows/columns of ≤16 cells; we allow up to 5 rows
    # or columns of bounding-box thickness as a "strip-like" cluster.
    if top_mined:
        xs = [x for (x, _) in top_mined]
        zs = [z for (_, z) in top_mined]
        x_span = max(xs) - min(xs) + 1
        z_span = max(zs) - min(zs) + 1
        # Strip-like = thin in at least one axis. Take the SHORT span.
        short_span = min(x_span, z_span)
        assert short_span <= 5, (
            f"mined cells are NOT in a strip — bounding box {x_span}×{z_span} too wide. "
            f"Strip should be thin (≤5) in one axis. diag={diag}"
        )

        # 4b. **Contiguity**: 4-neighbour flood-fill on the mined cells
        # at y=66 should yield one dominant connected component holding
        # most of the cells. A scattered "stars around the bot" pattern
        # produces many tiny disconnected components.
        mined_set = set(top_mined)
        seen: set[tuple[int, int]] = set()
        components: list[int] = []
        for cell in mined_set:
            if cell in seen:
                continue
            stack = [cell]
            size = 0
            while stack:
                cur = stack.pop()
                if cur in seen or cur not in mined_set:
                    continue
                seen.add(cur)
                size += 1
                cx_, cz_ = cur
                stack.extend([(cx_+1, cz_), (cx_-1, cz_), (cx_, cz_+1), (cx_, cz_-1)])
            components.append(size)
        components.sort(reverse=True)
        biggest = components[0] if components else 0
        # Require the largest component to hold at least 70% of mined cells.
        # A strip naturally is one connected run; ≥70% leaves slack for a
        # handful of incidental clutter pickups (surface bumps).
        threshold = max(1, int(len(top_mined) * 0.7))
        assert biggest >= threshold, (
            f"mined cells at y={PIT_TOP_Y} are NOT contiguous — largest "
            f"connected component is {biggest}/{len(top_mined)} cells "
            f"(want ≥{threshold}); component sizes={components}. diag={diag}"
        )

    # 5. **Boundary held** — pit perimeter is mineable; the boundary check
    # is "no cells OUTSIDE the pit were touched". The fixture air-fills
    # the working volume, so there's nothing to mine outside. We check
    # one neighbouring cell at each side just to be safe.
    OUTSIDE_SAMPLES = [
        (PIT_X_MIN - 1, PIT_TOP_Y, (PIT_Z_MIN + PIT_Z_MAX) // 2),
        (PIT_X_MAX + 1, PIT_TOP_Y, (PIT_Z_MIN + PIT_Z_MAX) // 2),
        ((PIT_X_MIN + PIT_X_MAX) // 2, PIT_TOP_Y, PIT_Z_MIN - 1),
        ((PIT_X_MIN + PIT_X_MAX) // 2, PIT_TOP_Y, PIT_Z_MAX + 1),
    ]
    for (sx, sy, sz) in OUTSIDE_SAMPLES:
        # Outside the pit there's only air at y=66 (no dirt was placed).
        # If the bot somehow placed dirt or the test stage is wrong,
        # this guards against it. We don't fail on air-found-air.
        assert rcon.block_is(sx, sy, sz, "air"), (
            f"unexpected non-air outside the pit at {sx},{sy},{sz}"
        )

    # 6. Bot survived.
    end_hp = bot.status_lean().get("health") or 0
    assert end_hp >= 17, f"bot lost HP during mine: {end_hp}. diag={diag}"
