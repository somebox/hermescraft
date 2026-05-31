"""Multiverse world lifecycle: delete, create, border, gamerules."""

from __future__ import annotations

import re
from typing import Any

from .rcon import ProceduralRcon
from .safety import assert_safe_world_name

_MV_CONFIRM_RE = re.compile(r"/mv confirm (\d+)", re.I)


def _mv_output_text(rcon: ProceduralRcon, raw: str) -> str:
    return rcon.strip_ansi(raw).lower()


def is_world_registered(rcon: ProceduralRcon, world: str) -> bool:
    raw = rcon.run("mv list")
    plain = rcon.strip_ansi(raw)
    return bool(re.search(rf"^{re.escape(world)}\s+-", plain, re.MULTILINE))


def _mv_delete_with_confirm(rcon: ProceduralRcon, world: str) -> str:
    out = rcon.run(f"mv delete {world}")
    m = _MV_CONFIRM_RE.search(rcon.strip_ansi(out))
    if m:
        out += rcon.run(f"mv confirm {m.group(1)}")
    return out


def delete_world_sync(rcon: ProceduralRcon, world: str) -> None:
    """Remove a proc-* MV world and its on-disk folder."""
    assert_safe_world_name(world)
    if rcon.dry_run:
        rcon.planned_commands.append(f"mv delete {world}")
        rcon.planned_commands.append(f"mv confirm <id>")
        rcon.planned_commands.append(f"[rm-data] /data/{world}")
        return

    out = _mv_delete_with_confirm(rcon, world)
    if is_world_registered(rcon, world):
        raise RuntimeError(
            f"Multiverse world {world!r} still registered after delete: "
            f"{rcon.strip_ansi(out)[:400]}"
        )
    rcon.remove_world_data_dir(world)


def delete_world(rcon: ProceduralRcon, world: str) -> list[str]:
    """Deprecated batch list — use delete_world_sync."""
    delete_world_sync(rcon, world)
    return []


def create_world_sync(
    rcon: ProceduralRcon, params: dict[str, Any], world: str, seed: int
) -> None:
    """Create MV world; handle orphan folders left by failed deletes."""
    assert_safe_world_name(world)
    cmds = create_world_commands(params, world, seed)
    out = rcon.run_batch(cmds)
    text = _mv_output_text(rcon, out)
    if "already exists in server folders" in text:
        rcon.remove_world_data_dir(world)
        out = rcon.run_batch(cmds)
        text = _mv_output_text(rcon, out)
    if "error:" in text and "imported" not in text and "created" not in text:
        raise RuntimeError(f"mv create failed for {world!r}: {rcon.strip_ansi(out)[:800]}")
    if not rcon.dry_run and not is_world_registered(rcon, world):
        raise RuntimeError(
            f"Multiverse world {world!r} is not registered after create "
            f"(check mv list / server logs)"
        )


def create_world_commands(params: dict[str, Any], world: str, seed: int) -> list[str]:
    create = params.get("create") or {}
    gen = str(create.get("generator", "NORMAL")).upper()
    structures = create.get("structures", True)
    no_struct = "" if structures else " --no-structures"
    if gen == "FLAT":
        return [
            f"mv create {world} NORMAL --world-type FLAT{no_struct} -s {seed}",
        ]
    return [
        f"mv create {world} NORMAL{no_struct} -s {seed}",
    ]


def runtime_setup_commands(params: dict[str, Any], world: str) -> list[str]:
    rt = params.get("runtime") or {}
    diff = rt.get("difficulty", "peaceful")
    mob = "true" if rt.get("mob_spawning", True) else "false"
    dc = "true" if rt.get("daylight_cycle", False) else "false"
    wc = "true" if rt.get("weather_cycle", False) else "false"
    ki = "true" if rt.get("keep_inventory", True) else "false"
    time_val = int(rt.get("time", 6000))
    weather = rt.get("weather", "clear")
    prefix = f"execute in {world} run"
    return [
        f"mv modify {world} set difficulty {diff}",
        f"execute in {world} run gamerule doMobSpawning {mob}",
        f"execute in {world} run gamerule doDaylightCycle {dc}",
        f"execute in {world} run gamerule doWeatherCycle {wc}",
        f"execute in {world} run gamerule keepInventory {ki}",
        f"{prefix} time set {time_val}",
        f"{prefix} weather {weather}",
    ]


def border_forceload_commands(map_cfg: dict[str, Any], world: str, params: dict[str, Any]) -> list[str]:
    cx = map_cfg["center_x"]
    cz = map_cfg["center_z"]
    diameter = map_cfg["diameter"]
    pregen = params.get("pregen") or {}
    margin = int(pregen.get("forceload_margin_chunks", 1))
    half = map_cfg["arena_half"]
    chunk_min_x = (cx - half) // 16 - margin
    chunk_max_x = (cx + half) // 16 + margin
    chunk_min_z = (cz - half) // 16 - margin
    chunk_max_z = (cz + half) // 16 + margin
    cmds = [
        f"execute in {world} run worldborder center {cx} {cz}",
        f"execute in {world} run worldborder set {diameter}",
    ]
    if pregen.get("forceload", True):
        cmds.append(
            f"execute in {world} run forceload add {chunk_min_x} {chunk_min_z} {chunk_max_x} {chunk_max_z}"
        )
    return cmds


def set_spawn_commands(world: str, x: int, y: int, z: int) -> list[str]:
    return [
        f"execute in {world} run setworldspawn {x} {y} {z}",
        f"mvsetspawn {world}:{x},{y},{z}",
    ]
