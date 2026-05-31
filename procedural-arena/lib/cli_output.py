"""CLI banners, progress lines, and run summaries for procedural-arena."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from .config_params import format_map_one_liner


def _log(msg: str) -> None:
    print(msg, flush=True)


def mc_connect_hint() -> dict[str, Any]:
    """Server + rcon targets from config/hermescraft.yaml (same as pytest/agent-test)."""
    repo = Path(__file__).resolve().parents[2]
    defaults = {
        "game_host": "ubuntu-host",
        "port": 25565,
        "ssh_host": "ubuntu-host",
        "docker_container": "minecraft",
    }
    try:
        import importlib.util

        cfg_path = repo / "tests" / "_lib" / "config.py"
        spec = importlib.util.spec_from_file_location("hermes_config", cfg_path)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(mod)
        cfg = mod.load_config()
        mc = cfg.get("mc") or {}
        rcon = cfg.get("rcon") or {}
        ssh_host = str(rcon.get("ssh_host", "ubuntu-host"))
        port = int(mc.get("port", 25565))
        container = str(rcon.get("docker_container", "minecraft"))
        env_host = os.environ.get("MC_HOST", "").strip()
        mc_host = str(mc.get("host", "localhost"))
        if env_host:
            game_host = env_host
        elif mc_host in ("localhost", "127.0.0.1"):
            game_host = ssh_host
        else:
            game_host = mc_host
        return {
            "game_host": game_host,
            "port": port,
            "ssh_host": ssh_host,
            "docker_container": container,
        }
    except Exception:
        return defaults


def _server_line(h: dict[str, Any]) -> str:
    return f"{h['game_host']}:{h['port']}"


def _rcon_line(h: dict[str, Any]) -> str:
    return f"ssh {h['ssh_host']} → docker exec {h['docker_container']} rcon-cli"


def _format_terrain_line(m: dict[str, Any]) -> str:
    prep = m.get("prep") or {}
    survey = m.get("survey") or {}
    transit = m.get("transit") or {}
    work = m.get("work") or {}
    ug = m.get("underground") or {}
    coal = work.get("coal_ore_samples", ug.get("coal_ore", "—"))
    iron = work.get("iron_ore_samples", ug.get("iron_ore", "—"))
    return (
        f"flat={prep.get('largest_flat_area', '—')} "
        f"grass={prep.get('grass_pct', '—')} "
        f"biomes={survey.get('unique_biome_count', '—')} "
        f"water={transit.get('water_pct', '—')} "
        f"coal={coal} iron={iron}"
    )


def _format_mobs_line(m: dict[str, Any]) -> str:
    work = m.get("work") or {}
    rt = m.get("runtime") or {}
    mobs: dict[str, int] = work.get("mobs") or {}
    diff = rt.get("difficulty", "?")
    spawn_on = rt.get("mob_spawning", True)
    parts = [
        f"total={work.get('mob_total', sum(mobs.values()) if mobs else 0)}",
        f"passive={work.get('mob_passive_total', '—')}",
        f"hostile={work.get('mob_hostile_total', '—')}",
        f"({diff}, doMobSpawning={spawn_on})",
    ]
    if mobs:
        detail = " ".join(f"{k}={v}" for k, v in sorted(mobs.items()) if v)
        if detail:
            parts.append(detail)
    return " ".join(str(p) for p in parts)


def print_run_start(
    *,
    world: str,
    map_cfg: dict[str, Any],
    seed: int | None,
    candidate_index: int,
    candidate_total: int,
    regenerate: bool,
    dry_run: bool,
    skip_pregen: bool,
    skip_inspect: bool,
    profile: str | None,
    fixture_id: str | None,
    generator: str,
    map_size_preset: str | None = None,
    verbose: bool = False,
) -> None:
    conn = mc_connect_hint()
    map_line = format_map_one_liner(map_cfg, preset=map_size_preset)
    mode_bits = []
    if regenerate:
        mode_bits.append("regenerate")
    if dry_run:
        mode_bits.append("dry-run")
    if skip_pregen:
        mode_bits.append("skip-pregen")
    if skip_inspect:
        mode_bits.append("skip-inspect")
    mode = " ".join(mode_bits) if mode_bits else "create-only"

    if not verbose:
        cand = f" [{candidate_index + 1}/{candidate_total}]" if candidate_total > 1 else ""
        seed_s = f" seed={seed}" if seed is not None else ""
        fix = f" fixture={fixture_id}" if fixture_id else ""
        _log(
            f"=== generate {world}{cand}  {map_line}{seed_s}{fix}  "
            f"{_server_line(conn)}  ({mode})"
        )
        return

    _log("=== procedural-arena generate ===")
    if candidate_total > 1:
        _log(f"  candidate {candidate_index + 1}/{candidate_total}")
    _log(f"  world:     {world}")
    _log(f"  map:       {map_line}")
    if map_size_preset:
        _log(f"  preset:    --map-size {map_size_preset}")
    _log(f"  generator: {generator}")
    if fixture_id:
        _log(f"  fixture:   {fixture_id}")
    if profile:
        _log(f"  profile:   {profile}")
    if seed is not None:
        _log(f"  seed:      {seed}")
    _log(f"  server:    {_server_line(conn)}  (MC client / bot; override MC_HOST)")
    _log(f"  rcon:      {_rcon_line(conn)}")
    _log(f"  mode:      {'dry-run (no ssh)' if dry_run else 'live rcon'}" + (" + regenerate" if regenerate else ""))
    phases = ["delete", "create", "border", "pregen" if not skip_pregen else None, "inspect" if not skip_inspect else None]
    _log(f"  phases:    {', '.join(p for p in phases if p)}")
    _log("")


def print_phase(phase: str, *, detail: str = "", verbose: bool = False) -> None:
    if not verbose:
        return
    suffix = f" — {detail}" if detail else ""
    _log(f"  → {phase}{suffix}...")


def print_phase_done(phase: str, seconds: float, *, verbose: bool = False) -> None:
    if not verbose:
        return
    _log(f"  ✓ {phase} ({seconds:.1f}s)")


def print_run_summary(
    report: dict[str, Any],
    params: dict[str, Any],
    report_path: Path,
    *,
    dry_run: bool = False,
    verbose: bool = False,
    map_size_preset: str | None = None,
) -> None:
    map_cfg = report.get("map") or {}
    ts = report.get("timing_seconds") or {}
    spawn = report.get("spawn_feet") or {}
    muster = report.get("muster") or spawn
    obs = params.get("observe") or {}
    observe_y = int(obs.get("y", 100))
    observe_pitch = int(obs.get("pitch", 45))
    world = report.get("world", "proc-lab")
    conn = mc_connect_hint()

    sx = spawn.get("x", 0)
    sy = spawn.get("y", 65)
    sz = spawn.get("z", 0)
    mx, my, mz = muster.get("x", sx), muster.get("y", sy), muster.get("z", sz)

    m = report.get("metrics") or {}
    preset = map_size_preset or report.get("map_size_preset")
    map_line = format_map_one_liner(map_cfg, preset=preset)
    total_s = ts.get("total", 0)
    fp = report.get("fingerprint") or {}

    if not verbose:
        _log("")
        head = f"=== {world} done  {total_s}s  seed={report.get('seed', '—')}  {map_line}"
        if report.get("composite_score") is not None:
            head += f"  score={report['composite_score']}"
        _log(head)
        phase_bits = []
        for key, label in (
            ("delete_world", "del"),
            ("create_world", "create"),
            ("border_forceload", "border"),
            ("inspect", "inspect"),
        ):
            if key in ts and ts[key]:
                phase_bits.append(f"{label} {ts[key]}s")
        if phase_bits:
            _log(f"timing   {' | '.join(phase_bits)}  (rcon {report.get('rcon_commands_sent', 0)} cmds)")
        _log(f"terrain  {_format_terrain_line(m)}")
        _log(f"mobs     {_format_mobs_line(m)}")
        _log(
            f"go       {_server_line(conn)}  "
            f"/mvtp Flint {world}  feet {sx},{sy},{sz}  muster {mx},{my},{mz}"
        )
        _log(f"report   {report_path}" + (f"  fp {fp['sha256'][:16]}…" if fp.get("sha256") else ""))
        _log("")
        return

    prep = m.get("prep") or {}
    survey = m.get("survey") or {}
    transit = m.get("transit") or {}
    work = m.get("work") or {}

    _log("")
    _log("=== done ===")
    _log(f"  report:    {report_path}")
    _log(f"  arena:     {map_line}")
    _log(f"  seed:      {report.get('seed', '—')}")
    if report.get("composite_score") is not None:
        _log(f"  score:     {report['composite_score']}")
    if report.get("candidate_ranking"):
        _log(f"  ranking:   {len(report['candidate_ranking'])} candidates (best seed {report.get('seed')})")

    _log(
        f"  timing:    total {total_s}s "
        f"(create {ts.get('create_world', 0)}s, inspect {ts.get('inspect', 0)}s, "
        f"rcon_cmds {report.get('rcon_commands_sent', 0)})"
    )

    _log("  inspect:")
    _log(f"    {_format_terrain_line(m)}")
    _log(f"    mobs: {_format_mobs_line(m)}")

    _log("  connect:")
    _log(f"    minecraft: {_server_line(conn)}")
    _log(f"    rcon:      {_rcon_line(conn)}" + (" (skipped in dry-run)" if dry_run else ""))
    _log(f"    bot env:   MC_HOST={conn['game_host']} MC_PORT={conn['port']}")
    _log("  in-game (Flint):")
    _log(f"    /mvtp Flint {world}")
    _log(f"    /execute in {world} run tp Flint {sx} {sy} {sz}")
    _log(f"    muster @ ({mx}, {my}, {mz})")
    _log(f"  observe (FPV): tp {sx} {observe_y} {sz}, pitch ~{observe_pitch}")
    if fp.get("sha256"):
        _log(f"  fingerprint: sha256:{fp['sha256'][:16]}…")
    _log("")
