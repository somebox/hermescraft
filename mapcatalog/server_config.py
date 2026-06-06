from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class ServerConfig:
    minecraft_version: str
    ssh_host: str
    container: str
    cli: str
    world_name: str
    generator: str
    hub_world: str
    hub_xyz: tuple[int, int, int]
    use_unsafe_mvtp: bool
    evac_bot_players: tuple[str, ...] = ("Flint",)
    command_timeout_s: float = 120.0
    batch_timeout_s: float = 600.0
    cubiomes_binary: str | None = None
    cubiomes_mc_enum: str | None = None


def load_server_config(path: Path) -> ServerConfig:
    with path.open(encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: expected mapping")

    rcon = raw.get("rcon") or {}
    world = raw.get("world") or {}
    evac = world.get("evac") or {}
    cubiomes = raw.get("cubiomes") or {}

    transport = str(rcon.get("transport", "ssh_docker"))
    if transport != "ssh_docker":
        raise NotImplementedError(f"rcon transport {transport!r} — only ssh_docker for now")

    name = str(world.get("name", "proc-lab"))
    if not name.startswith("proc-"):
        raise ValueError(f"world.name must match proc-* safety rule, got {name!r}")

    hub = evac.get("hub_xyz") or [0, 65, 0]
    bots = evac.get("bot_players") or ["Flint"]
    if isinstance(bots, str):
        bots = [bots]
    return ServerConfig(
        minecraft_version=str(raw.get("minecraft_version", "1.21.4")),
        ssh_host=str(rcon["ssh_host"]),
        container=str(rcon["container"]),
        cli=str(rcon.get("cli", "rcon-cli")),
        world_name=name,
        generator=str(world.get("generator", "NORMAL")),
        hub_world=str(evac.get("hub_world", "landfolk-test")),
        hub_xyz=(int(hub[0]), int(hub[1]), int(hub[2])),
        use_unsafe_mvtp=bool(evac.get("use_unsafe_mvtp", True)),
        evac_bot_players=tuple(str(b) for b in bots),
        command_timeout_s=float(rcon.get("command_timeout_s", 120)),
        batch_timeout_s=float(rcon.get("batch_timeout_s", 600)),
        cubiomes_binary=str(cubiomes["binary"]) if cubiomes.get("binary") else None,
        cubiomes_mc_enum=str(cubiomes.get("mc_enum")) if cubiomes.get("mc_enum") else None,
    )
