"""Resolve procedural_env blocks for agent-test integration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .fingerprint import compute_fingerprint

ARENA_ROOT = Path(__file__).resolve().parents[1]


def load_inspect_report(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def resolve_procedural_env(spec: dict[str, Any], arena_root: Path | None = None) -> dict[str, Any]:
    """Turn agent-test procedural_env YAML into world + spawn + cleanup plan."""
    root = arena_root or ARENA_ROOT
    pe = spec.get("procedural_env") or {}
    if not pe:
        raise ValueError("missing procedural_env block")

    fixture_id = pe.get("fixture_id")
    seed_mode = pe.get("seed_mode", "from_report")
    report_path = pe.get("report_path")
    if seed_mode == "from_report":
        if not report_path:
            raise ValueError("seed_mode from_report requires report_path")
        rp = Path(report_path)
        if not rp.is_absolute():
            rp = root.parent / rp if (root.parent / rp).exists() else root / rp
        report = load_inspect_report(rp)
    else:
        report = pe.get("_resolved_report") or {}

    world = report.get("world") or spec.get("world") or pe.get("world", "proc-lab")
    spawn = report.get("spawn_feet")
    if pe.get("spawn") == "from_report.spawn_feet" or not pe.get("spawn"):
        spawn = report.get("spawn_feet")
    muster = report.get("muster")
    cleanup_bbox = report.get("cleanup_bbox")
    work_bbox = report.get("work_bbox")
    fp_in = report.get("fingerprint_inputs") or {}
    fingerprint = compute_fingerprint(fp_in, inspect_hash=pe.get("fingerprint", {}).get("inspect_hash"))

    return {
        "world": world,
        "spawn_feet": spawn,
        "muster": muster,
        "work_bbox": work_bbox,
        "cleanup_bbox": cleanup_bbox,
        "fingerprint": fingerprint,
        "fixture_id": fixture_id,
        "seed_mode": seed_mode,
        "report": report,
    }


def cleanup_commands_from_report(report: dict[str, Any]) -> list[str]:
    world = report["world"]
    bb = report.get("cleanup_bbox") or {}
    x1, y1, z1 = int(bb["x1"]), int(bb["y1"]), int(bb["z1"])
    x2, y2, z2 = int(bb["x2"]), int(bb["y2"]), int(bb["z2"])
    muster = report.get("muster") or report.get("spawn_feet") or {"x": 0, "y": 65, "z": 0}
    mx, my, mz = int(muster["x"]), int(muster["y"]), int(muster["z"])
    return [
        f"execute in {world} run kill @e[type=!player]",
        f"execute in {world} run fill {x1} {y1} {z1} {x2} {y2} {z2} minecraft:air",
        f"mvtp Flint {world}",
        f"execute in {world} run tp Flint {mx} {my} {mz}",
    ]
