from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any

import yaml

from mapcatalog.gates import parse_gate_item
from mapcatalog.models import Arena, FindSpec, PlacementSpec, Requirements
from mapcatalog.placements import parse_placement_value, topological_sort_placements


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, val in override.items():
        if key in out and isinstance(out[key], dict) and isinstance(val, dict):
            out[key] = _deep_merge(out[key], val)
        else:
            out[key] = copy.deepcopy(val)
    return out


def _repo_root(start: Path) -> Path:
    for p in [start, *start.parents]:
        if (p / "mapcatalog").is_dir() and (p / "AGENTS.md").exists():
            return p
    return start.parent


def _resolve_extends(path: Path, extends: str) -> Path:
    root = _repo_root(path.parent)
    cand = path.parent / extends
    if cand.suffix != ".yaml":
        cand = Path(str(cand) + ".yaml")
    if cand.is_file():
        return cand
    cand2 = root / extends
    if cand2.suffix != ".yaml":
        cand2 = Path(str(cand2) + ".yaml")
    if cand2.is_file():
        return cand2
    raise FileNotFoundError(f"extends not found: {extends!r} (from {path})")


def load_yaml_dict(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping at root")
    return data


def _load_with_extends(path: Path, visited: set[Path] | None = None) -> dict[str, Any]:
    """Load a YAML dict with the `extends` chain resolved (deep merge).
    Cycle-safe via a visited set. Used to walk profile → requirements →
    harness chains without losing the profile's gates/placements."""
    path = path.resolve()
    if visited is None:
        visited = set()
    if path in visited:
        raise ValueError(f"extends cycle: {path} already in chain {visited}")
    visited = visited | {path}
    raw = load_yaml_dict(path)
    if "extends" in raw:
        parent_path = _resolve_extends(path, str(raw["extends"]))
        parent = _load_with_extends(parent_path, visited)
        raw = _deep_merge(parent, raw)
        raw.pop("extends", None)
    return raw


def load_requirements(path: Path) -> Requirements:
    path = path.resolve()
    raw = _load_with_extends(path)

    req_id = str(raw.get("id") or path.stem)
    arena_raw = raw.get("arena") or {}
    center = arena_raw.get("center", [0, 0])
    arena = Arena(center=(int(center[0]), int(center[1])), radius=int(arena_raw.get("radius", 64)))

    gates = [parse_gate_item(g) for g in raw.get("gates") or []]

    placements_raw = raw.get("placements")
    if placements_raw is None:
        placements_raw = {}
        if "spawn" in raw:
            placements_raw["spawn"] = raw["spawn"]
        if "muster" in raw:
            placements_raw["muster"] = raw["muster"]
    if not placements_raw.get("spawn"):
        placements_raw = dict(placements_raw)
        placements_raw.setdefault("spawn", "random_safe radius 1 attempts 32")
    if not placements_raw.get("muster"):
        placements_raw = dict(placements_raw)
        placements_raw.setdefault("muster", "offset_from spawn [6, 0, 0]")

    specs = [parse_placement_value(name, val) for name, val in placements_raw.items()]
    placements = topological_sort_placements(specs)

    find_raw = raw.get("find", {})
    if isinstance(find_raw, str):
        find = _parse_find_line(find_raw)
    elif isinstance(find_raw, dict):
        find = FindSpec(
            solutions=int(find_raw.get("solutions", 5)),
            max_seeds=int(find_raw.get("max_seeds", 200)),
            seed_candidates=[str(s) for s in (find_raw.get("seed_candidates") or find_raw.get("seeds") or [])],
        )
    else:
        find = FindSpec()

    prep = [str(p) for p in raw.get("prep") or []]
    server_path = raw.get("server")
    mc_ver = raw.get("minecraft_version")

    return Requirements(
        id=req_id,
        path=str(path),
        arena=arena,
        gates=gates,
        placements=placements,
        find=find,
        server_path=str(server_path) if server_path else None,
        minecraft_version=str(mc_ver) if mc_ver else None,
        prep=prep,
        source_lines=raw,
    )


_FIND_RE = re.compile(
    r"^(?P<solutions>\d+)\s+solutions\s+max\s+(?P<max_seeds>\d+)\s+seeds\s*$",
    re.IGNORECASE,
)


def _parse_find_line(text: str) -> FindSpec:
    m = _FIND_RE.match(text.strip())
    if not m:
        raise ValueError(f"cannot parse find line: {text!r}")
    return FindSpec(solutions=int(m.group("solutions")), max_seeds=int(m.group("max_seeds")))
