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

Assertions (codify the strip-mine primitive's contract: mine X/Z rows
and columns in level-by-level order — drop Y only when the current
plane has no more in-range candidates):

  1. Bot mined at least 25 cells (most of the 32-budget). Some slack
     for natural primitive failures.
  2. Middle layer (y=65) fully intact across all 256 cells.
  3. Bottom layer (y=64) fully intact across all 256 cells.
  4. **Strict contiguity at y=66**: mined cells at the strip level
     form ONE 4-connected component. Stray cells outside the largest
     component are only allowed if they sit directly under a mined
     y=67 clutter cell — legitimate "dig-through-column" pattern.
  5. **Top-before-bottom in-column**: for any surviving y=67 clutter
     cell, the y=66 cell directly below MUST still be dirt. The bot
     must clear the higher cell in a column before digging the lower
     one.
  6. Boundary held — pit perimeter at y=66 stays air (no cells mined
     OUTSIDE the 16×16 pit footprint).
  7. Bot HP unchanged.
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

    # 4. **Strict contiguity at y=66**: mined cells at the strip level
    # form one 4-connected component. Any stray (= cells in a smaller
    # component) is only allowed if it sits directly under a mined
    # y=67 clutter cell — the bot legitimately dug through a column
    # to clear a higher block, leaving the y=66 cell below as an
    # isolated dig site.
    #
    # The OLD 70%-largest-component rule let scatter patterns slip
    # through. The strict rule reflects the SUT's actual contract:
    # mine X/Z rows and columns in level-by-level order.
    if top_mined:
        mined_set = set(top_mined)
        visited: set[tuple[int, int]] = set()
        components: list[set[tuple[int, int]]] = []
        for cell in mined_set:
            if cell in visited:
                continue
            stack = [cell]
            comp: set[tuple[int, int]] = set()
            while stack:
                cur = stack.pop()
                if cur in visited or cur not in mined_set:
                    continue
                visited.add(cur)
                comp.add(cur)
                cx_, cz_ = cur
                for n in ((cx_+1, cz_), (cx_-1, cz_), (cx_, cz_+1), (cx_, cz_-1)):
                    if n in mined_set and n not in visited:
                        stack.append(n)
            components.append(comp)
        components.sort(key=len, reverse=True)
        strip = components[0]
        unexplained_strays = []
        for comp in components[1:]:
            for (sx, sz) in comp:
                # Allowed iff y=67 above was also mined (clutter dig-through).
                if not rcon.block_is(sx, PIT_TOP_Y + 1, sz, "air"):
                    unexplained_strays.append((sx, sz))
        assert not unexplained_strays, (
            f"strip at y={PIT_TOP_Y} has scatter — mined cells outside "
            f"the largest connected component AND not under a mined "
            f"clutter column: {unexplained_strays}. "
            f"largest_strip={len(strip)} cells, "
            f"total_mined_y66={len(top_mined)}, "
            f"component_sizes={[len(c) for c in components]}. diag={diag}"
        )

    # 5. **Top-before-bottom in-column**: for any SURVIVING y=67 clutter
    # cell, the y=66 cell directly below MUST still be dirt. The bot
    # must clear the higher cell in a column before digging the lower
    # one in that same column. Captures level-by-level order without
    # requiring global y=67 clearance (some clutter may be out of
    # range within the 32-budget).
    column_violations = []
    for (cx, cy, cz) in SURFACE_CLUTTER:
        if rcon.block_is(cx, cy, cz, "dirt"):           # clutter survived
            if rcon.block_is(cx, PIT_TOP_Y, cz, "air"):  # but y=66 below was mined
                column_violations.append((cx, cz))
    assert not column_violations, (
        f"top-before-bottom violation: bot mined y={PIT_TOP_Y} at columns "
        f"where y={PIT_TOP_Y+1} above was still clutter. "
        f"Columns: {column_violations}. diag={diag}"
    )

    # 6. **Boundary held** — pit perimeter is mineable; the boundary check
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

    # 7. Bot survived.
    end_hp = bot.status_lean().get("health") or 0
    assert end_hp >= 17, f"bot lost HP during mine: {end_hp}. diag={diag}"
