from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass
from typing import Protocol

from mapcatalog.models import Arena
from mapcatalog.probe import line_indicates_block_match
from mapcatalog.server_config import ServerConfig


class LifecycleRcon(Protocol):
    def run(self, cmd: str) -> str: ...

    def run_batch(self, cmds: list[str]) -> str: ...


def assert_proc_world(name: str) -> None:
    if not name.startswith("proc-"):
        raise ValueError(f"refusing lifecycle on non proc-* world: {name!r}")


def evac_players(client: LifecycleRcon, cfg: ServerConfig) -> None:
    """Move configured bot accounts out of the scratch world (not all @a).

    Human players on other worlds (e.g. campaign ``world``) are untouched.
    Only names in ``evac.bot_players`` are mvtp'd when present in proc-lab.
    """
    w = cfg.world_name
    hub = cfg.hub_world
    hx, hy, hz = cfg.hub_xyz
    for name in cfg.evac_bot_players:
        client.run(
            f"execute in {w} as @a[name={name},limit=1] run mvtp @s {hub} {hx} {hy} {hz}"
        )


# On the MV build this code targets (Paper 1.21 + MV-Core), `mv delete <w>` is a
# two-step confirm flow: the first call emits `Run /mv confirm <OTP>` and the
# delete only completes when the OTP is echoed back. The earlier `--force` flag
# was rejected as `not a valid flag`, so the delete never happened and `mv
# create` no-op'd against the orphan world (which stayed UNLOADED). Symptom:
# every Pass 2 probe got `Unknown dimension 'minecraft:proc-lab'` and the
# metrics came back as 49 cells of flat air.
_MV_CONFIRM_OTP = re.compile(r"mv confirm\s+(\S+)", re.IGNORECASE)


def delete_and_create_world(client: LifecycleRcon, cfg: ServerConfig, seed: str) -> None:
    assert_proc_world(cfg.world_name)
    w = cfg.world_name
    gen = cfg.generator
    # Unload before delete (no-op if already unloaded).
    client.run(f"mv unload {w}")
    # Request delete → parse the OTP from the prompt → confirm.
    out = client.run(f"mv delete {w}")
    m = _MV_CONFIRM_OTP.search(out)
    if m:
        client.run(f"mv confirm {m.group(1)}")
    # Create fresh. MV does NOT auto-load on this build — load explicitly so the
    # vanilla `execute in <w>` path resolves the dimension namespace.
    client.run(f"mv create {w} {gen} -s {seed}")
    client.run(f"mv load {w}")


def preload_arena_chunks(client: LifecycleRcon, cfg: ServerConfig, arena: Arena) -> None:
    """Force-load chunks covering the arena disc and touch one column to pull terrain."""
    w = cfg.world_name
    cx, cz = arena.center
    r = arena.radius
    chunk_radius = int(math.ceil(r / 16)) + 1
    ccx, ccz = cx // 16, cz // 16
    cmds: list[str] = []
    for dx in range(-chunk_radius, chunk_radius + 1):
        for dz in range(-chunk_radius, chunk_radius + 1):
            cmds.append(f"execute in {w} run forceload add {ccx + dx} {ccz + dz}")
    # Touch center column at several Y to encourage surface + underground gen.
    for y in (64, 32, 0):
        cmds.append(f"execute in {w} run setblock {cx} {y} {cz} minecraft:air replace minecraft:air")
    for i in range(0, len(cmds), 80):
        client.run_batch(cmds[i : i + 80])
    time.sleep(2.0)


class WorldProbeError(RuntimeError):
    """Scratch world is not loaded or rcon probes cannot resolve the dimension."""


def assert_world_probe_ready(
    client: LifecycleRcon,
    cfg: ServerConfig,
    arena: Arena,
) -> None:
    """Fail fast before sampling — unloaded worlds return empty stdout and fake flat metrics."""
    w = cfg.world_name
    cx, cz = arena.center
    out = client.run(f"execute in {w} if block {cx} 64 {cz} #minecraft:air")
    text = (out or "").lower()
    if "unknown dimension" in text or "incorrect argument for command" in text:
        raise WorldProbeError(
            f"dimension {w!r} not loaded — check mv delete confirm + mv load lifecycle"
        )
    if not (out or "").strip():
        listing = client.run("mv list").lower()
        if w.lower() in listing and "unloaded" in listing:
            raise WorldProbeError(f"world {w!r} is UNLOADED per mv list")
        raise WorldProbeError(
            f"empty rcon response probing {w} at ({cx}, 64, {cz}) — dimension likely missing"
        )
    if line_indicates_block_match(out):
        return
    if "test failed" in text or "failed" in text:
        return
    raise WorldProbeError(f"unexpected probe preamble for {w!r}: {out!r}")


@dataclass
class MaterializeReport:
    world_name: str
    seed: str
    duration_s: float
    evacuated: bool = True
    reused: bool = False


def materialize_seed(
    client: LifecycleRcon,
    cfg: ServerConfig,
    seed: str,
    arena: Arena,
    *,
    reuse_if_seed: bool = False,
    requirements_id: str | None = None,
) -> MaterializeReport:
    from mapcatalog.proc_state import seed_matches_loaded, write_state

    t0 = time.monotonic()
    if reuse_if_seed and seed_matches_loaded(cfg.world_name, seed):
        preload_arena_chunks(client, cfg, arena)
        assert_world_probe_ready(client, cfg, arena)
        return MaterializeReport(
            world_name=cfg.world_name,
            seed=seed,
            duration_s=time.monotonic() - t0,
            evacuated=False,
            reused=True,
        )

    evac_players(client, cfg)
    delete_and_create_world(client, cfg, seed)
    preload_arena_chunks(client, cfg, arena)
    assert_world_probe_ready(client, cfg, arena)
    write_state(world_name=cfg.world_name, seed=seed, requirements_id=requirements_id)
    return MaterializeReport(
        world_name=cfg.world_name,
        seed=seed,
        duration_s=time.monotonic() - t0,
        evacuated=True,
        reused=False,
    )
