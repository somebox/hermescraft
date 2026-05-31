"""Load defaults.yaml + optional experiment.yaml; merge CLI overrides."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

ARENA_ROOT = Path(__file__).resolve().parents[1]
DEFAULTS_PATH = ARENA_ROOT / "params" / "defaults.yaml"
EXPERIMENT_PATH = ARENA_ROOT / "params" / "experiment.yaml"


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        import yaml
    except ImportError as e:
        raise RuntimeError("PyYAML required: pip install pyyaml") from e
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data if isinstance(data, dict) else {}


def resolve_map(params: dict[str, Any]) -> dict[str, Any]:
    m = copy.deepcopy(params.get("map") or {})
    radius = int(m.get("border_radius", 128))
    half = m.get("arena_half")
    if half is None:
        half = radius
    half = int(half)
    cx = int(m.get("center_x", 0))
    cz = int(m.get("center_z", 0))
    diameter = radius * 2
    return {
        "center_x": cx,
        "center_z": cz,
        "border_radius": radius,
        "diameter": diameter,
        "arena_half": half,
        "approx_area_blocks2": (2 * half + 1) ** 2,
    }


def load_params() -> dict[str, Any]:
    base = _load_yaml(DEFAULTS_PATH)
    exp = _load_yaml(EXPERIMENT_PATH)
    if not base:
        raise FileNotFoundError(f"missing {DEFAULTS_PATH}")
    merged = copy.deepcopy(base)
    for k, v in exp.items():
        if isinstance(v, dict) and isinstance(merged.get(k), dict):
            merged[k] = {**merged[k], **v}
        else:
            merged[k] = v
    return merged


def map_size_cli_epilog(params: dict[str, Any] | None = None) -> str:
    """Short footer for generate.py / inspect_world.py --help."""
    params = params or load_params()
    presets = params.get("map_size_presets") or {}
    lines = [
        "map-size (--map-size): worldborder radius from center 0,0",
    ]
    for name in ("small", "medium", "large"):
        if name not in presets:
            continue
        r = int(presets[name])
        tag = "  default in params/defaults.yaml" if name == "medium" else ""
        lines.append(f"  {name:6}  r={r}  diameter={2 * r}{tag}")
    lines.extend(
        [
            "",
            "docs: procedural-arena/README.md",
            "",
            "examples:",
            "  ./procedural-arena/regenerate.sh --map-size small",
            "  python3 procedural-arena/inspect_world.py --world proc-lab",
            "  python3 procedural-arena/generate.py --map-size small --seed 424242 --regenerate",
            "  python3 procedural-arena/generate.py --map-size small --scenario mining --candidates 5 --regenerate",
            "  add -v for per-phase progress",
        ]
    )
    return "\n".join(lines)


def map_size_help_text(params: dict[str, Any] | None = None) -> str:
    """Alias for CLI epilog (README has the full table)."""
    return map_size_cli_epilog(params)


def format_map_one_liner(map_cfg: dict[str, Any], *, preset: str | None = None) -> str:
    d = map_cfg.get("diameter", "?")
    r = map_cfg.get("border_radius", "?")
    half = map_cfg.get("arena_half", r)
    tag = f"{preset} " if preset else ""
    return f"{tag}{d}⌀ r={r} half={half} @ ({map_cfg.get('center_x', 0)},{map_cfg.get('center_z', 0)})"


def apply_map_size_preset(params: dict[str, Any], preset: str | None) -> None:
    if not preset:
        return
    presets = params.get("map_size_presets") or {}
    if preset not in presets:
        raise ValueError(f"unknown map-size preset {preset!r}; choose from {list(presets)}")
    r = int(presets[preset])
    params.setdefault("map", {})
    params["map"]["border_radius"] = r
    if params["map"].get("arena_half") is None:
        params["map"]["arena_half"] = r
