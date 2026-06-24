"""F47 live smoke: flee from a visible zombie (hostile_mob path).

NO_THREAT / passive cow cases are in `bot/test/actions/combat-contract.test.js`.
Spatial need: mob_spawn_origin. Specialty pad: Origin. Observer: (0, 72, 0).
"""

from __future__ import annotations

import time

import pytest


@pytest.fixture
def empty_world(rcon, arena, config, functional_world):
    world = config["mc"]["world"]
    yield
    rcon.batch([
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run difficulty peaceful",
    ])


def _spawn_mob(rcon, world: str, kind: str, x: float, y: float, z: float) -> None:
    rcon.run(
        f"execute in {world} run summon {kind} {x} {y} {z} "
        "{Silent:1b,PersistenceRequired:1b}"
    )
    time.sleep(0.5)


@pytest.mark.functional
def test_flee_zombie_triggers_hostile_mob_flee(bot, rcon, config, empty_world):
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run difficulty easy")
    _spawn_mob(rcon, world, "zombie", 3, 65, 0)
    time.sleep(1.0)
    try:
        r = bot.post("/action/flee", {"distance": 16}, timeout=25)
        assert r.get("ok"), r
        data = r.get("data") or {}
        threat = data.get("threat") or {}
        assert threat.get("name") == "zombie", data
        assert (data.get("flee_reason") or "").startswith("hostile_mob:"), data
    finally:
        rcon.batch([
            f"execute in {world} run kill @e[type=zombie]",
            f"execute in {world} run difficulty peaceful",
        ])
        try:
            bot.post("/action/stop", {}, timeout=3.0)
        except Exception:
            pass
