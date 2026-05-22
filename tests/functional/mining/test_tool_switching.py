"""Task #34.1: mining auto-switches between pickaxe and shovel.

circuit-v7 (2026-05-22): Steve used iron_pickaxe to break dirt while
mining the W1 outcrop. Dirt with a pickaxe is ~5× slower than dirt
with a shovel, so the 6-block W1 task took ~5 min instead of ~30s.
The fix lives in `bot/lib/runtime/dig-tools.js` —
`preferHarvestToolForBlock` now equips a shovel for sand/dirt/gravel
blocks before each swing, matching the pickaxe branch.

This test locks down the behavior at the action level:

  A. Bot holds iron_pickaxe initially. Asked to collect dirt. After
     the dig, bot must be holding a shovel.

  B. Bot holds iron_shovel initially. Asked to collect stone. After
     the dig, bot must be holding a pickaxe.

Both rounds use the lean status response which surfaces `holding` so
the assertion doesn't need to peek at mineflayer internals.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def tool_switch_arena(rcon, arena, tester_bot, config):
    """Arena: 1 dirt at (-2, 65, 2), 1 stone at (2, 65, 2). Bot has both
    iron_pickaxe and iron_shovel; default-held item depends on the order
    they're given (Minecraft gives to slot 0 first)."""
    world = config["mc"]["world"]
    tester_bot.wait_until_ready(timeout=10)
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute as Tester at @s in {world} run tp @s 0 65 0",
    ])
    arena.settle(seconds=2.5)
    arena.flat_arena((-10, 64, -10, 10, 80, 10), floor="grass_block")
    rcon.batch([
        f"execute in {world} run setblock -2 65 2 minecraft:dirt",
        f"execute in {world} run setblock 2 65 2 minecraft:stone",
        "clear Tester",
        # Give shovel FIRST so it lands in hotbar slot 0 (default-held).
        # The test then explicitly asks the bot to collect stone, which
        # forces the pickaxe equip. For dirt, the shovel is already
        # held — but we still want to prove the tool-switch logic
        # exercises both directions, so part A starts with pickaxe-held
        # and part B starts with shovel-held.
        f"execute in {world} run give Tester minecraft:iron_pickaxe 1",
        f"execute in {world} run give Tester minecraft:iron_shovel 1",
        f"execute in {world} run effect give Tester minecraft:instant_health 1 5",
        f"execute in {world} run tp Tester 0 65 1 0 0",
    ])
    arena.settle(seconds=2.5)
    yield
    arena.flat_arena((-10, 60, -10, 10, 80, 10), floor="grass_block")
    arena.forceload_remove_all()


def _holding(bot) -> str:
    """Return the bot's currently-held item name via status_lean.

    The lean status surfaces `holding` as an object {name, count} (built
    via itemStr in bot/lib/runtime/observation.js). The /healthz endpoint
    uses just the string. Normalize to the bare name for assertions."""
    st = bot.status_lean()
    held = st.get("holding")
    if isinstance(held, dict):
        return held.get("name") or "empty"
    return held or "empty"


@pytest.mark.functional
def test_collect_dirt_equips_shovel(bot, tool_switch_arena):
    """A: starting with pickaxe held, asked to collect dirt — should
    auto-switch to shovel before digging."""
    # Force a known starting state: pickaxe held.
    bot.post("/action/equip", {"item": "iron_pickaxe"}, timeout=8)
    assert _holding(bot) == "iron_pickaxe", f"setup failed, holding={_holding(bot)!r}"

    bot.post("/action/goto_near", {"x": -2, "y": 65, "z": 2, "range": 1}, timeout=15)
    r = bot.post("/action/collect", {"block": "dirt", "count": 1}, timeout=45)
    assert r.get("ok"), r

    held = _holding(bot)
    assert held == "iron_shovel", (
        f"dirt collect should leave bot holding a shovel; got {held!r}. "
        "Tool-switch logic missing or skipped the shovel branch."
    )


@pytest.mark.functional
def test_collect_stone_equips_pickaxe(bot, tool_switch_arena):
    """B: starting with shovel held, asked to collect stone — should
    auto-switch to pickaxe before digging."""
    bot.post("/action/equip", {"item": "iron_shovel"}, timeout=8)
    assert _holding(bot) == "iron_shovel", f"setup failed, holding={_holding(bot)!r}"

    bot.post("/action/goto_near", {"x": 2, "y": 65, "z": 2, "range": 1}, timeout=15)
    r = bot.post("/action/collect", {"block": "stone", "count": 1}, timeout=45)
    assert r.get("ok"), r

    held = _holding(bot)
    assert held == "iron_pickaxe", (
        f"stone collect should leave bot holding a pickaxe; got {held!r}. "
        "Tool-switch logic missing or skipped the pickaxe branch."
    )
