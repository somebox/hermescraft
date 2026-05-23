"""Reactive combat scenario specs (parity with scripts/combat-suite.sh FIXTURES)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from tests._lib.combat_fixtures import (
    combat_loadout,
    combat_night_prep,
    lay_cobble_arena,
    summon_target,
)
from tests._lib.rcon import RconClient

ApplyFn = Callable[[RconClient, str], None]


@dataclass(frozen=True)
class ReactiveScenario:
    id: str
    apply: ApplyFn
    pass_mode: str = "cleared"
    timeout_s: int = 30
    creeper_flee: bool = False
    survive_after_s: int = 12
    min_hp: float = 15.0
    extra_tags: tuple[str, ...] = field(default_factory=tuple)


def _w(world: str, cmd: str) -> str:
    return f"execute in {world} run {cmd}"


def _apply_l360(rcon: RconClient, world: str) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -10 65 -10 10 80 10 minecraft:air"),
        _w(world, "fill -10 64 -10 10 64 10 minecraft:stone"),
    ])
    lay_cobble_arena(rcon, world, half=3, height=3)
    rcon.batch([
        _w(world, "setblock -2 66 -2 minecraft:torch"),
        _w(world, "setblock 2 66 -2 minecraft:torch"),
        _w(world, "setblock -2 66 2 minecraft:torch"),
        _w(world, "setblock 2 66 2 minecraft:torch"),
        _w(world, "tp Tester 0 65 0"),
        _w(world, "effect clear Tester"),
    ])
    combat_loadout(rcon, world, sword=None, instant_health=True)
    summon_target(rcon, world, "zombie", 2, 65, 0)


def _apply_l361(rcon: RconClient, world: str) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -3 65 -3 15 70 3 minecraft:air"),
        _w(world, "fill -3 64 -3 15 64 3 minecraft:stone"),
        _w(world, "fill -3 65 -3 15 67 -3 minecraft:cobblestone"),
        _w(world, "fill -3 65 3 15 67 3 minecraft:cobblestone"),
        _w(world, "fill -3 65 -3 -3 67 3 minecraft:cobblestone"),
        _w(world, "fill 15 65 -3 15 67 3 minecraft:cobblestone"),
        _w(world, "setblock 0 66 -2 minecraft:torch"),
        _w(world, "setblock 0 66 2 minecraft:torch"),
        _w(world, "setblock 12 66 -2 minecraft:torch"),
        _w(world, "setblock 12 66 2 minecraft:torch"),
        _w(world, "tp Tester 0 65 0"),
    ])
    combat_loadout(rcon, world, sword="wooden_sword", armor_head="iron_helmet", instant_health=True)
    summon_target(
        rcon,
        world,
        "skeleton",
        10,
        65,
        0,
        hand_items='[{id:"minecraft:bow",Count:1b},{}]',
    )


def _apply_l362(rcon: RconClient, world: str) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -8 65 -8 8 70 8 minecraft:air"),
        _w(world, "fill -8 64 -8 8 64 8 minecraft:stone"),
        _w(world, "fill -8 65 -8 8 67 -8 minecraft:cobblestone"),
        _w(world, "fill -8 65 8 8 67 8 minecraft:cobblestone"),
        _w(world, "fill -8 65 -8 -8 67 8 minecraft:cobblestone"),
        _w(world, "fill 8 65 -8 8 67 8 minecraft:cobblestone"),
        _w(world, "setblock -7 66 -7 minecraft:torch"),
        _w(world, "setblock 7 66 -7 minecraft:torch"),
        _w(world, "setblock -7 66 7 minecraft:torch"),
        _w(world, "setblock 7 66 7 minecraft:torch"),
        _w(world, "setblock 0 66 0 minecraft:torch"),
        _w(world, "tp Tester 0 65 0"),
    ])
    combat_loadout(rcon, world, sword=None, instant_health=False)
    summon_target(rcon, world, "creeper", 5, 65, 0)


def _apply_l364(rcon: RconClient, world: str) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -5 65 -5 15 80 5 minecraft:air"),
        _w(world, "fill -10 50 -10 15 64 10 minecraft:stone"),
        _w(world, "setblock -3 66 -3 minecraft:torch"),
        _w(world, "setblock 6 66 -3 minecraft:torch"),
        _w(world, "setblock -3 66 3 minecraft:torch"),
        _w(world, "setblock 6 66 3 minecraft:torch"),
        _w(world, "tp Tester 0 65 0"),
        _w(world, "damage Tester 8 generic"),
    ])
    combat_loadout(rcon, world, sword="wooden_sword", instant_health=False)
    summon_target(rcon, world, "zombie", 2, 65, 0)


def _apply_l366(rcon: RconClient, world: str) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -10 65 -5 10 80 5 minecraft:air"),
        _w(world, "fill -10 64 -5 10 64 5 minecraft:stone"),
        _w(world, "fill -7 65 -3 8 68 -3 minecraft:cobblestone"),
        _w(world, "fill -7 65 3 8 68 3 minecraft:cobblestone"),
        _w(world, "fill -7 65 -3 -7 68 3 minecraft:cobblestone"),
        _w(world, "fill 8 65 -3 8 68 3 minecraft:cobblestone"),
        _w(world, "setblock 6 65 0 minecraft:cobblestone"),
        _w(world, "setblock -6 66 -2 minecraft:torch"),
        _w(world, "setblock -6 66 2 minecraft:torch"),
        _w(world, "setblock 0 66 -2 minecraft:torch"),
        _w(world, "setblock 0 66 2 minecraft:torch"),
        _w(world, "setblock 4 66 -2 minecraft:torch"),
        _w(world, "setblock 4 66 2 minecraft:torch"),
        _w(world, "tp Tester -6 65 0"),
    ])
    combat_loadout(rcon, world, sword=None, instant_health=False)
    summon_target(
        rcon,
        world,
        "skeleton",
        6,
        66,
        0,
        hand_items='[{id:"minecraft:bow",Count:1b},{}]',
    )


def _apply_l367(rcon: RconClient, world: str) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -7 65 -7 7 70 7 minecraft:air"),
        _w(world, "fill -7 64 -7 7 64 7 minecraft:stone"),
        _w(world, "fill -6 65 -6 6 67 -6 minecraft:cobblestone"),
        _w(world, "fill -6 65 6 6 67 6 minecraft:cobblestone"),
        _w(world, "fill -6 65 -6 -6 67 6 minecraft:cobblestone"),
        _w(world, "fill 6 65 -6 6 67 6 minecraft:cobblestone"),
        _w(world, "fill -2 65 -2 -2 66 -2 minecraft:stone"),
        _w(world, "fill 2 65 -2 2 66 -2 minecraft:stone"),
        _w(world, "fill -2 65 2 -2 66 2 minecraft:stone"),
        _w(world, "fill 2 65 2 2 66 2 minecraft:stone"),
        _w(world, "setblock -5 66 -5 minecraft:torch"),
        _w(world, "setblock 5 66 -5 minecraft:torch"),
        _w(world, "setblock -5 66 5 minecraft:torch"),
        _w(world, "setblock 5 66 5 minecraft:torch"),
        _w(world, "tp Tester 0 65 0"),
    ])
    combat_loadout(rcon, world, sword="wooden_sword", armor_head="iron_helmet", instant_health=False)
    summon_target(rcon, world, "zombie", -5, 65, -5)
    summon_target(rcon, world, "zombie", 5, 65, 5)


def _apply_multi_zombie_cardinals(rcon: RconClient, world: str, *, extra_tags: bool) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -10 65 -10 10 80 10 minecraft:air"),
        _w(world, "fill -10 64 -10 10 64 10 minecraft:stone"),
    ])
    lay_cobble_arena(rcon, world, half=4, height=3)
    rcon.batch([
        _w(world, "setblock -3 66 -3 minecraft:torch"),
        _w(world, "setblock 3 66 -3 minecraft:torch"),
        _w(world, "setblock -3 66 3 minecraft:torch"),
        _w(world, "setblock 3 66 3 minecraft:torch"),
        _w(world, "tp Tester 0 65 0"),
        _w(world, "effect clear Tester"),
    ])
    combat_loadout(rcon, world, sword="wooden_sword", instant_health=True)
    spawns = [
        ("zombie", 0, 65, -3, ("target", "zN") if extra_tags else ("target",)),
        ("zombie", 0, 65, 3, ("target", "zS") if extra_tags else ("target",)),
        ("zombie", 3, 65, 0, ("target", "zE") if extra_tags else ("target",)),
        ("zombie", -3, 65, 0, ("target", "zW") if extra_tags else ("target",)),
    ]
    for kind, x, y, z, tags in spawns:
        summon_target(rcon, world, kind, x, y, z, tags=tags)


def _apply_l370(rcon: RconClient, world: str) -> None:
    _apply_multi_zombie_cardinals(rcon, world, extra_tags=True)


def _apply_l371(rcon: RconClient, world: str) -> None:
    _apply_multi_zombie_cardinals(rcon, world, extra_tags=False)


def _apply_l372(rcon: RconClient, world: str) -> None:
    combat_night_prep(rcon, world)
    rcon.batch([
        _w(world, "fill -7 65 -7 7 70 7 minecraft:air"),
        _w(world, "fill -7 64 -7 7 64 7 minecraft:stone"),
        _w(world, "fill -6 65 -6 6 68 -6 minecraft:cobblestone"),
        _w(world, "fill -6 65 6 6 68 6 minecraft:cobblestone"),
        _w(world, "fill -6 65 -6 -6 68 6 minecraft:cobblestone"),
        _w(world, "fill 6 65 -6 6 68 6 minecraft:cobblestone"),
        _w(world, "setblock -5 65 -5 minecraft:stone"),
        _w(world, "setblock 5 65 5 minecraft:stone"),
        _w(world, "setblock -5 66 0 minecraft:torch"),
        _w(world, "setblock 5 66 0 minecraft:torch"),
        _w(world, "setblock 0 66 -5 minecraft:torch"),
        _w(world, "setblock 0 66 5 minecraft:torch"),
        _w(world, "tp Tester 0 65 0"),
    ])
    combat_loadout(rcon, world, sword="wooden_sword", instant_health=False)
    summon_target(
        rcon,
        world,
        "skeleton",
        -5,
        66,
        -5,
        hand_items='[{id:"minecraft:bow",Count:1b},{}]',
    )
    summon_target(
        rcon,
        world,
        "skeleton",
        5,
        66,
        5,
        hand_items='[{id:"minecraft:bow",Count:1b},{}]',
    )
    summon_target(rcon, world, "zombie", 0, 65, -3)


FIGHT_SCENARIOS: tuple[ReactiveScenario, ...] = (
    ReactiveScenario("L3.60_fight_zombie", _apply_l360),
    ReactiveScenario("L3.61_fight_skeleton", _apply_l361),
    ReactiveScenario("L3.64_fight_retreat_low_hp", _apply_l364, pass_mode="cleared_or_alive"),
    ReactiveScenario("L3.67_fight_two_zombies_obstacles", _apply_l367),
    ReactiveScenario("L3.70_multi_zombie_stress", _apply_l370),
    ReactiveScenario("L3.71_multi_zombie_four", _apply_l371),
    ReactiveScenario("L3.72_mixed_skeletons_zombie", _apply_l372),
)

FLEE_SCENARIOS: tuple[ReactiveScenario, ...] = (
    ReactiveScenario(
        "L3.62_flee_creeper",
        _apply_l362,
        pass_mode="survived_hp",
        creeper_flee=True,
        survive_after_s=12,
        min_hp=15.0,
    ),
    ReactiveScenario(
        "L3.66_dodge_skeleton",
        _apply_l366,
        pass_mode="survived_hp",
        timeout_s=30,
        min_hp=0.0,
    ),
)

ALL_PARITY_SCENARIOS: tuple[ReactiveScenario, ...] = FIGHT_SCENARIOS + FLEE_SCENARIOS

SCENARIO_BY_ID = {s.id: s for s in ALL_PARITY_SCENARIOS}
