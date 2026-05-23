"""Stuck-watchdog re-centre: bot wedged against a wall corner should recover.

Migrated from scripts/test-stuck-recenter.py. When the bot is partially
inside a block (xz partially over a solid neighbor), it can't move
along the axis that would clip the geometry — pathfinder keeps issuing
`forward` but velocity stays at zero. The stuck watchdog detects this
AND, when the bot is significantly off-centre in its standing cell,
looks toward the cell centre and steps forward briefly to re-centre.

Scenario: bot at (3.9, 65, 0.5) pressed against a cobble wall at x=3
(spanning z=-1..1, 2 tall). Call goto -1,65,0. Without the fix, bot
stays wedged for the entire timeout. With it, bot reaches x<1 within 22s.
"""

from __future__ import annotations

import threading
import time

import pytest


@pytest.fixture
def wedge_arena(rcon, arena, tester_bot, config):
    """Grass floor, 3-block-tall cobble wall at x=3, bot pressed against
    east face at (3.9, 65, 0.5) — hitbox crosses the x=4 boundary so the
    direct west step is blocked by the wall's east face.
    """
    world = config["mc"]["world"]
    rcon.batch([
        # 2-block-tall wall, 3 cells long along z, so the bot can't trivially go around.
        f"execute in {world} run setblock 3 65 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 3 65 0 minecraft:cobblestone",
        f"execute in {world} run setblock 3 65 1 minecraft:cobblestone",
        f"execute in {world} run setblock 3 66 -1 minecraft:cobblestone",
        f"execute in {world} run setblock 3 66 0 minecraft:cobblestone",
        f"execute in {world} run setblock 3 66 1 minecraft:cobblestone",
        f"execute in {world} run tp Tester 3.9 65 0.5 90 0",  # yaw 90 = facing west
    ])
    arena.settle_water()
    yield


@pytest.mark.functional
def test_wedged_bot_recenters_and_navigates_west(bot, wedge_arena):
    """Fire goto -1,65,0 on a background thread; poll position every 1s
    until x<1 (success) or 22s elapses (failure).

    The watchdog should: detect 8s of no movement → detect off-centre
    (offX = 3.9 - 3.5 = 0.4) → look toward centre → step forward → re-
    centre. Without the fix the bot stays wedged the entire window.
    """
    result: dict = {}
    def call_goto():
        try:
            result["r"] = bot.post("/action/goto", {"x": -1, "y": 65, "z": 0}, timeout=25)
        except Exception as e:
            result["r"] = {"ok": False, "error": str(e)}

    t = threading.Thread(target=call_goto, daemon=True)
    t.start()
    progressed = False
    for _ in range(22):
        time.sleep(1.0)
        x = bot.position().get("x", 99)
        if x < 1.0:
            progressed = True
            break
    t.join(timeout=5)
    final_x = bot.position().get("x", 99)
    assert progressed or final_x < 1.0, f"bot stayed wedged; final x={final_x}"
