"""Primitive-level fair-play combat: attack must not 'stab' through walls.

Migrated from scripts/test-attack-through-wall.py. Reproduces the G20 v24
exploit — mineflayer's bot.attack() is packet-level; Paper accepts it
on melee reach alone. We enforce LOS in bot/lib/actions/combat.js before
swinging. Plus the reactive layer's self_defense path (which fired
bot.attack() directly without LOS) was fixed too — scenario D covers it.

Scenarios:
  A: open LOS to zombie at (3,65,0) → attack succeeds, zombie HP drops.
  B: bot sealed in 1×1 cobble shelter, zombie at (2,65,0) → mc attack
     refused with ATTACK_BLOCKED / "line of sight" / "blocked"; HP intact.
  C: same as B but using mc fight (looping verb) → 0 hits, HP intact.
  D: reactive layer (mode=normal) over 4s of ticks — must not auto-attack
     through walls. HP intact.
"""

from __future__ import annotations

import re
import time

import pytest


@pytest.fixture
def combat_arena(rcon, arena, flint_bot, config):
    """Open stone-floored region + iron armor + iron sword + saturation +
    midnight (avoid sunburn drain). Each scenario then places the
    zombie + optional cobble shelter."""
    world = config["mc"]["world"]
    flint_bot.wait_until_ready(timeout=10)
    rcon.run(f"execute in {world} run tp Flint 0 100 0 0 0")
    arena.clean()
    arena.forceload((-1, -1, 1, 1))
    rcon.batch([
        f"execute in {world} run difficulty easy",
        f"execute in {world} run gamerule mobGriefing false",
        f"execute in {world} run gamerule doInsomnia false",
        f"execute in {world} run gamerule doMobSpawning false",
        f"execute in {world} run time set midnight",
        # Packed sub-floor + open arena
        f"execute in {world} run fill -6 60 -6 6 70 6 minecraft:air",
        f"execute in {world} run fill -6 60 -6 6 63 6 minecraft:stone",
        f"execute in {world} run fill -6 64 -6 6 64 6 minecraft:stone",
    ])
    arena.settle(seconds=0.5)
    yield
    rcon.run(f"execute in {world} run tp Flint 0 100 0 0 0")
    rcon.batch([
        f"execute in {world} run kill @e[type=zombie]",
        f"execute in {world} run fill -6 60 -6 6 70 6 minecraft:air",
    ])
    arena.forceload_remove_all()


def _stage_combat(rcon, world: str, sealed: bool) -> None:
    """Place optional cobble shell + Flint at center + zombie + gear.

    The settle at the end is load-bearing: with <2s, mineflayer's
    bot.entity.position lags the server TP and `mc attack` swings from
    the stale position. Particularly noticeable when this test follows
    another in the suite (state-bleed in mineflayer's perception).
    """
    cmds = [f"execute in {world} run kill @e[type=!player]"]
    if sealed:
        for (dx, dy, dz) in [
            (1, 0, 0), (-1, 0, 0), (0, 0, 1), (0, 0, -1),
            (1, 1, 0), (-1, 1, 0), (0, 1, 1), (0, 1, -1),
            (0, 2, 0),
        ]:
            cmds.append(
                f"execute in {world} run setblock {dx} {65 + dy} {dz} minecraft:cobblestone"
            )
    zombie_x = 3 if not sealed else 2
    cmds += [
        f"execute in {world} run tp Flint 0 65 0 90 0",
        "clear Flint",
        "give Flint minecraft:iron_sword 1",
        "give Flint minecraft:iron_helmet 1",
        "give Flint minecraft:iron_chestplate 1",
        "give Flint minecraft:iron_leggings 1",
        "give Flint minecraft:iron_boots 1",
        "effect clear Flint",
        "effect give Flint minecraft:saturation 600 1",
        f"execute in {world} run effect give Flint instant_health 1 4",
        f'execute in {world} run summon zombie {zombie_x} 65 0 '
        f'{{NoAI:1b,Silent:1b,PersistenceRequired:1b,CustomName:\'"target"\',Health:20f}}',
    ]
    rcon.batch(cmds)
    time.sleep(3.0)


def _zombie_hp(rcon, world: str) -> float | None:
    """Read the LOWEST zombie HP. Robust against mob-spawning leaks."""
    out = rcon.run(
        f"execute in {world} run execute as @e[type=zombie] run data get entity @s Health"
    )
    if not out or "Found no" in out:
        return None
    hps = [float(m.group(1)) for m in re.finditer(r"data:\s*([0-9]+(?:\.[0-9]+)?)\s*f", out)]
    return min(hps) if hps else None


def _hold_mode(bot) -> None:
    try:
        bot.post("/action/mode", {"name": "hold"}, timeout=5)
    except Exception:
        pass


@pytest.mark.functional
def test_attack_with_clear_view_damages_zombie(bot, rcon, config, combat_arena):
    """A: zombie in open at (3,65,0) — attack succeeds, HP drops."""
    world = config["mc"]["world"]
    _stage_combat(rcon, world, sealed=False)
    _hold_mode(bot)
    hp0 = _zombie_hp(rcon, world)
    assert hp0 is not None, "no zombie spawned"
    r = bot.post("/action/attack", {"target": "zombie"}, timeout=30)
    assert r.get("ok"), r
    # Damage application can lag the API response — wait long enough for
    # Paper to commit the damage tick. Empirically 0.5s wasn't reliable
    # mid-suite; 2.0s gives plenty of headroom.
    time.sleep(2.0)
    hp1 = _zombie_hp(rcon, world)
    assert hp1 is not None and hp1 < hp0, f"HP didn't drop: {hp0} → {hp1}; attack response={r.get('data')}"


@pytest.mark.functional
def test_attack_through_shelter_wall_is_refused(bot, rcon, config, combat_arena):
    """B: bot sealed, zombie at (2,65,0) — attack refused, HP intact."""
    world = config["mc"]["world"]
    _stage_combat(rcon, world, sealed=True)
    _hold_mode(bot)
    hp0 = _zombie_hp(rcon, world)
    assert hp0 is not None
    r = bot.post("/action/attack", {"target": "zombie"}, timeout=30)
    assert not r.get("ok"), r
    err = r.get("error") or {}
    code = err.get("code") if isinstance(err, dict) else ""
    msg = (err.get("message") if isinstance(err, dict) else err) or ""
    refused = (
        code == "ATTACK_BLOCKED"
        or "line of sight" in str(msg).lower()
        or "blocked" in str(msg).lower()
    )
    assert refused, r
    time.sleep(0.5)
    hp1 = _zombie_hp(rcon, world)
    assert hp1 is not None and abs(hp1 - hp0) < 0.01, f"HP changed despite refused attack: {hp0} → {hp1}"


@pytest.mark.functional
def test_fight_loop_lands_no_hits_through_wall(bot, rcon, config, combat_arena):
    """C: same sealed setup, mc fight (looping verb) — HP intact after duration."""
    world = config["mc"]["world"]
    _stage_combat(rcon, world, sealed=True)
    _hold_mode(bot)
    hp0 = _zombie_hp(rcon, world)
    assert hp0 is not None
    bot.post("/action/fight", {"target": "zombie", "duration": 4, "retreat_health": 4}, timeout=15)
    time.sleep(0.5)
    hp1 = _zombie_hp(rcon, world)
    assert hp1 is not None and abs(hp1 - hp0) < 0.01, f"HP changed during fight: {hp0} → {hp1}"


@pytest.mark.functional
def test_reactive_self_defense_does_not_attack_through_wall(bot, rcon, config, combat_arena):
    """D: reactive layer (mode=normal) — 4s of self_defense ticks must NOT
    damage the zombie through the shelter wall. G20 v31 lost a bot to this."""
    world = config["mc"]["world"]
    _stage_combat(rcon, world, sealed=True)
    try:
        bot.post("/action/mode", {"name": "normal"}, timeout=5)
    except Exception:
        pass
    hp0 = _zombie_hp(rcon, world)
    assert hp0 is not None
    time.sleep(4.0)
    hp1 = _zombie_hp(rcon, world)
    assert hp1 is not None and abs(hp1 - hp0) < 0.01, (
        f"reactive layer attacked through wall: HP {hp0} → {hp1}"
    )
