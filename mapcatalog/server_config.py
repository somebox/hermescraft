from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


@dataclass(frozen=True)
class ServerConfig:
    minecraft_version: str
    # ssh_docker fields (empty strings if transport=tcp)
    ssh_host: str
    container: str
    cli: str
    world_name: str
    generator: str
    hub_world: str
    hub_xyz: tuple[int, int, int]
    use_unsafe_mvtp: bool
    # New fields below have defaults so the old positional constructor in tests still works.
    transport: str = "ssh_docker"
    tcp_host: str = ""
    tcp_port: int = 0
    tcp_password: str = ""
    evac_bot_players: tuple[str, ...] = ("Flint",)
    command_timeout_s: float = 120.0
    batch_timeout_s: float = 600.0
    cubiomes_binary: str | None = None
    cubiomes_mc_enum: str | None = None


def _read_password(rcon: dict[str, Any]) -> str:
    pw = rcon.get("password")
    if pw:
        return str(pw)
    pf = rcon.get("password_file")
    if pf:
        text = Path(str(pf)).expanduser().read_text(encoding="utf-8").strip()
        if not text:
            raise ValueError(f"rcon.password_file {pf!r} is empty")
        return text
    raise ValueError("rcon transport=tcp requires rcon.password or rcon.password_file")


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
    if transport == "ssh_docker":
        ssh_host = str(rcon["ssh_host"])
        container = str(rcon["container"])
        cli = str(rcon.get("cli", "rcon-cli"))
        tcp_host = ""
        tcp_port = 0
        tcp_password = ""
    elif transport == "tcp":
        ssh_host = ""
        container = ""
        cli = ""
        tcp_host = str(rcon.get("host", "127.0.0.1"))
        tcp_port = int(rcon.get("port", 25575))
        tcp_password = _read_password(rcon)
    else:
        raise NotImplementedError(f"rcon transport {transport!r}")

    name = str(world.get("name", "proc-lab"))
    if not name.startswith("proc-"):
        raise ValueError(f"world.name must match proc-* safety rule, got {name!r}")

    hub = evac.get("hub_xyz") or [0, 65, 0]
    bots = evac.get("bot_players") or ["Flint"]
    if isinstance(bots, str):
        bots = [bots]
    return ServerConfig(
        minecraft_version=str(raw.get("minecraft_version", "1.21.4")),
        transport=transport,
        ssh_host=ssh_host,
        container=container,
        cli=cli,
        tcp_host=tcp_host,
        tcp_port=tcp_port,
        tcp_password=tcp_password,
        world_name=name,
        generator=str(world.get("generator", "NORMAL")),
        hub_world=str(evac.get("hub_world", "landfolk-test")),
        hub_xyz=(int(hub[0]), int(hub[1]), int(hub[2])),
        use_unsafe_mvtp=bool(evac.get("use_unsafe_mvtp", True)),
        evac_bot_players=tuple(str(b) for b in bots),
        command_timeout_s=float(rcon.get("command_timeout_s", 120 if transport == "ssh_docker" else 30)),
        batch_timeout_s=float(rcon.get("batch_timeout_s", 600 if transport == "ssh_docker" else 120)),
        cubiomes_binary=str(cubiomes["binary"]) if cubiomes.get("binary") else None,
        cubiomes_mc_enum=str(cubiomes.get("mc_enum")) if cubiomes.get("mc_enum") else None,
    )
