"""Water-aware mining: bot ON the sand pile, water guard is real defense.

Scenario: a 9×9 sand pile, 4 layers deep (y=62..65). Inside the top
surface there's a "trap zone" — a 3×3 water cluster with a single sand
cell at its center, surrounded by water on all 4 horizontal faces. If
the bot's water guard fails, mining that center cell unleashes the
biggest possible flood from a single block break.

The bot starts STANDING on the sand pile, 3 blocks west of the water
trap. Its only way to reach more sand is to walk toward — and around —
the water. Drowning risk is real: a guard failure would let water
cascade across the bot's standing area.

Geometry (top view y=65):

       x= 4  5  6  7  8  9 10 11 12
   z= 4  S  S  S  S  S  S  S  S  S
   z= 5  S  S  S  S  S  S  S  S  S
   z= 6  S  S  S  W  W  W  S  S  S
   z= 7  S  S  S  W  S  W  S  S  S   ← center sand trapped by water
   z= 8  S  S  S  W  W  W  S  S  S
   z= 9  S  S  S  S  S  S  S  S  S
   z=10  S  S  S  S  S  S  S  S  S
   z=11  S  S  S  S  S  S  S  S  S
   z=12  S  S  S  S  S  S  S  S  S

Bot stand: (5, 66, 7) — feet on sand at (5, 65, 7), 3 cells west of
the trap. Facing east, looking at the water.

Test placement: x ∈ [4, 12], z ∈ [4, 12] — adjacent to the strip-mine
arena at x ∈ [-5, 25] for one-glance visual inspection of both.

The center cell (8, 65, 7) is the strict-guard stress test: 4 water
neighbours, every adjacent dig in fair-play should refuse it. If the
bot mines it anyway the test catches the breach AND the bot may end
up partially submerged.
"""

from __future__ import annotations

import time

import pytest


VOLUME = (0, 58, 0, 16, 70, 16)
SAND_X_MIN, SAND_X_MAX = 4, 12
SAND_Z_MIN, SAND_Z_MAX = 4, 12
SAND_Y_MIN, SAND_Y_MAX = 62, 65   # 4-layer sand pile

# 3×3 water cluster on the top surface, with a single sand cell in the
# middle that's surrounded by water on all 4 horizontal faces.
WATER_CELLS = [
    (7, 65, 6), (8, 65, 6), (9, 65, 6),
    (7, 65, 7),             (9, 65, 7),
    (7, 65, 8), (8, 65, 8), (9, 65, 8),
]
# The center sand inside the water ring — the "trap" the guard must refuse.
TRAP_SAND = (8, 65, 7)

# Bot stands ON the sand pile, 3 cells west of the trap.
BOT_TP = (5.5, 66.0, 7.5, -90, 0)   # feet at y=66, facing west? No: -90 yaw = west, +90 = east. Adjust below.
# Actually MC yaw: 0=south, 90=west, 180=north, -90/270=east. We want
# the bot facing east toward the water cluster.
BOT_TP = (5.5, 66.0, 7.5, -90, 0)


@pytest.fixture
def water_arena(rcon, arena, tester_bot, config):
    """Build the 9×9×4 sand pile with the central water trap."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    arena.rescue_tester(safe_xyz=(BOT_TP[0], BOT_TP[1], BOT_TP[2]), bot=tester_bot)
    arena.clean()
    x1, y1, z1, x2, y2, z2 = VOLUME
    cmds = [
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air",
        f"execute in {world} run fill {x1} {y1} {z1} {x2} 61 {z2} minecraft:stone",
        # 9×9 sand pile, 4 layers deep — bot at y=66 lands on top y=65.
        f"execute in {world} run fill {SAND_X_MIN} {SAND_Y_MIN} {SAND_Z_MIN} "
        f"{SAND_X_MAX} {SAND_Y_MAX} {SAND_Z_MAX} minecraft:sand",
        "clear Tester",
        "give Tester minecraft:stone_shovel",
        "effect clear Tester",
        "effect give Tester minecraft:saturation 600 1",
    ]
    # Water cluster overwrites top-layer sand at the trap.
    for (wx, wy, wz) in WATER_CELLS:
        cmds.append(f"execute in {world} run setblock {wx} {wy} {wz} minecraft:water")
    # Back to survival, re-TP onto the sand top, then heal — so the
    # bot lands cleanly and instant_health propagates while stationary.
    cmds.extend([
        "gamemode survival Tester",
        f"execute in {world} run tp Tester {BOT_TP[0]} {BOT_TP[1]} {BOT_TP[2]} {BOT_TP[3]} {BOT_TP[4]}",
        "effect give Tester minecraft:instant_health 1 5",
    ])
    rcon.batch(cmds)
    arena.settle(seconds=3.0)
    yield
    rcon.run(f"execute in {world} run tp Tester 0 100 0 0 0")
    rcon.run(f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air")


@pytest.mark.functional
def test_water_guard_holds_when_bot_is_in_flood_path(bot, rcon, arena, water_arena):
    """Bot is asked for 30 sand while standing 3 blocks west of a water
    trap. Most of the 9×9 surface is safely mineable; the water-adjacent
    sand (and the trap center) must be refused.

    The test fails loudly if the bot loses HP — that would mean water
    actually reached the bot's standing area (guard failure)."""
    # Pre-test conditions: survival, on the pile (y≥65.5), full HP.
    pre = arena.verify_tester_ready(
        bot,
        expected_xz=(BOT_TP[0], BOT_TP[2]),
        expected_y_at_least=65.5,
        min_hp=17,
        xz_tol=1.5,
    )
    pre_hp = pre.get("health") or 0

    # Confirm the trap is set up correctly.
    for (wx, wy, wz) in WATER_CELLS:
        assert rcon.block_is(wx, wy, wz, "water"), (
            f"setup: water cell {wx},{wy},{wz} is not water"
        )
    assert rcon.block_is(*TRAP_SAND, "sand"), (
        f"setup: trap center {TRAP_SAND} should be sand"
    )

    # Drive the mine. 30 is more than the pile's surface alone — bot
    # will need to dig deeper layers AND will look toward the trap.
    r = bot.post("/action/collect", {"block": "sand", "count": 30}, timeout=120.0)
    assert r is not None
    data = (r.get("data") or {}) if isinstance(r, dict) else {}

    # 1. NO water breached. Every original water cell still water.
    for (wx, wy, wz) in WATER_CELLS:
        assert rcon.block_is(wx, wy, wz, "water"), (
            f"BOUNDARY BREACH: water cell at {wx},{wy},{wz} is gone — "
            f"bot dug into the trap"
        )

    # 2. The trap center sand — surrounded by water on 4 horizontal
    # faces — must NEVER be mined. This is the strict-guard stress.
    assert rcon.block_is(*TRAP_SAND, "sand"), (
        f"BOUNDARY BREACH: bot mined the trap center sand at {TRAP_SAND} — "
        f"water guard failed catastrophically"
    )

    # 3. Bot HP unchanged — water did not reach the bot's standing area.
    # If the guard failed and water cascaded toward the bot, partial
    # submersion would knock HP down (drowning damage starts at ~15s
    # underwater but the post-flood air count drops fast).
    end = bot.status_lean()
    end_hp = end.get("health") or 0
    assert end_hp >= pre_hp - 1, (
        f"bot took damage during mine: pre={pre_hp} post={end_hp} — "
        f"water guard may have failed and flooded the work area"
    )

    # 4. Bot mined some sand — the guard must not be over-restrictive.
    # Most of the 9×9 surface (sans the 8-cell water trap and ~8 cells
    # immediately adjacent) is safely mineable. Asking for 30 with a
    # ~73-cell safe top surface plus deeper layers, ≥10 mined is the
    # low bar. We check `mined_count` from the response rather than
    # inventory: pickup at the bottom of dug columns is a known
    # separate flakiness orthogonal to the water question.
    mined = data.get("mined_count", 0)
    assert mined >= 10, (
        f"bot mined too few sand cells: {mined}. "
        f"Possible over-restrictive guard. r.data={data}"
    )
