"""Shared helpers for reactive combat functional tests (L3.6x/7x port)."""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tests._lib.bot import BotClient
    from tests._lib.rcon import RconClient


def _in(world: str, cmd: str) -> str:
    return f"execute in {world} run {cmd}"


def combat_night_prep(rcon: RconClient, world: str) -> None:
    """Difficulty + night + mobGriefing off; kill stray mobs."""
    rcon.batch([
        _in(world, "difficulty easy"),
        _in(world, "time set night"),
        _in(world, "gamerule doDaylightCycle false"),
        _in(world, "gamerule mobGriefing false"),
        _in(world, "kill @e[type=!player]"),
    ])


def lay_cobble_arena(
    rcon: RconClient,
    world: str,
    *,
    half: int = 8,
    height: int = 3,
    floor_y: int = 64,
    feet_y: int = 65,
) -> None:
    """Cobble walls on a stone floor patch; no full arena floor replacement."""
    h = half
    y0, y1 = feet_y, feet_y + height - 1
    rcon.batch([
        _in(world, f"fill {-h} {floor_y} {-h} {h} {floor_y} {h} minecraft:stone"),
        _in(world, f"fill {-h} {y0} {-h} {h} {y1} {-h} minecraft:cobblestone"),
        _in(world, f"fill {-h} {y0} {h} {h} {y1} {h} minecraft:cobblestone"),
        _in(world, f"fill {-h} {y0} {-h} {-h} {y1} {h} minecraft:cobblestone"),
        _in(world, f"fill {h} {y0} {-h} {h} {y1} {h} minecraft:cobblestone"),
    ])


def summon_target(
    rcon: RconClient,
    world: str,
    kind: str,
    x: int | float,
    y: int | float,
    z: int | float,
    *,
    tags: tuple[str, ...] = ("target",),
    no_ai: bool = False,
    hand_items: str | None = None,
    persistence: bool = True,
    extra_nbt: str = "",
) -> None:
    tag_list = ",".join(f'"{t}"' for t in tags)
    nbt_parts = [f"PersistenceRequired:{1 if persistence else 0}b", f'Tags:[{tag_list}]']
    if no_ai:
        nbt_parts.append("NoAI:1b")
    if hand_items:
        nbt_parts.append(f"HandItems:{hand_items}")
    if extra_nbt:
        nbt_parts.append(extra_nbt.strip(","))
    nbt = "{" + ",".join(nbt_parts) + "}"
    rcon.run(_in(world, f"summon minecraft:{kind} {x} {y} {z} {nbt}"))


def count_targets(rcon: RconClient, world: str) -> int:
    """Count @e[tag=target] without adding random entity tags."""
    out = rcon.run(
        _in(
            world,
            "execute if entity @e[tag=target,type=!player]",
        )
    )
    m = re.search(r"count:\s*(\d+)", out or "", re.IGNORECASE)
    if m:
        return int(m.group(1))
    if out and "Test failed" in out:
        return 0
    return 0


def combat_loadout(
    rcon: RconClient,
    world: str,
    *,
    sword: str | None = "wooden_sword",
    armor_head: str | None = None,
    instant_health: bool = True,
    saturation: bool = True,
    clear_inventory: bool = True,
) -> None:
    cmds: list[str] = []
    if clear_inventory:
        cmds.append("clear Tester")
    if sword:
        cmds.append(f"give Tester minecraft:{sword} 1")
    if armor_head:
        cmds.append(f"give Tester minecraft:{armor_head} 1")
        cmds.append(f"item replace entity Tester armor.head with minecraft:{armor_head} 1")
    if saturation:
        cmds.append("effect give Tester minecraft:saturation 600 1")
    if instant_health:
        cmds.append(_in(world, "effect give Tester instant_health 1 5 true"))
    if cmds:
        rcon.batch(cmds)


def hold_reactive(bot: BotClient) -> None:
    try:
        bot.post("/action/mode", {"name": "hold"}, timeout=5)
    except Exception:
        pass


def arm_reactive(bot: BotClient, *, skill: float = 0.5, mode: str = "normal") -> None:
    bot.post("/action/combat_skill", {"value": skill}, timeout=5)
    bot.post("/action/mode", {"name": mode}, timeout=5)


def bot_hp(bot: BotClient) -> float | None:
    obs = bot.observe()
    state = obs.get("state") or {}
    hp = state.get("health")
    if hp is None:
        return None
    try:
        return float(hp)
    except (TypeError, ValueError):
        return None


def run_reactive_measurement(
    bot: BotClient,
    rcon: RconClient,
    world: str,
    *,
    pass_mode: str,
    timeout_s: int = 30,
    survive_after_s: int = 12,
    min_hp: float = 15.0,
    creeper_flee: bool = False,
    skill: float = 0.5,
) -> None:
    """Poll until pass/fail; mirrors scripts/combat-suite.sh reactive loop."""
    hold_reactive(bot)
    try:
        t0 = count_targets(rcon, world)
        assert t0 > 0 or pass_mode in ("survived_hp",), (
            f"no targets at start (mode={pass_mode})"
        )
        arm_reactive(bot, skill=skill, mode="normal")

        for i in range(1, timeout_s + 1):
            time.sleep(1.0)
            n = count_targets(rcon, world)
            hp = bot_hp(bot)

            if n == 0 and t0 > 0:
                if creeper_flee:
                    raise AssertionError(f"creeper detonated or cleared at {i}s hp={hp}")
                if pass_mode in ("cleared", "cleared_or_alive"):
                    return

            if creeper_flee and i >= survive_after_s and hp is not None and hp > min_hp:
                return

            if pass_mode == "survived_hp" and i >= (timeout_s - 5):
                if hp is not None and hp > min_hp:
                    return

        if pass_mode == "cleared_or_alive":
            hp = bot_hp(bot)
            if hp is not None and hp > 0:
                return
            raise AssertionError(f"bot dead after {timeout_s}s")
        if pass_mode == "cleared":
            raise AssertionError(f"targets not cleared after {timeout_s}s")
        if pass_mode == "survived_hp":
            hp = bot_hp(bot)
            if hp is not None and hp > min_hp:
                return
        raise AssertionError(f"timeout after {timeout_s}s pass_mode={pass_mode}")
    finally:
        hold_reactive(bot)
