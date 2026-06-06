from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import yaml

from mapcatalog.models import Arena
from mapcatalog.pass1 import run_biome_scan
from mapcatalog.server_config import ServerConfig


DEFAULT_ENUM_SWEEP = ("MC_1_21", "MC_1_21_3", "MC_1_21_1")


@dataclass
class CalibrateReport:
    ok: bool
    results: list[dict[str, Any]]


def load_calibration(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected mapping")
    return data


def run_enum_sweep(
    cfg: ServerConfig,
    cal_path: Path,
    enums: tuple[str, ...] = DEFAULT_ENUM_SWEEP,
) -> list[dict[str, Any]]:
    """Run calibration seeds under multiple cubiomes mc_enum values (offline)."""
    cal = load_calibration(cal_path)
    step = int(cal.get("step", 16))
    rows: list[dict[str, Any]] = []
    for mc_enum in enums:
        cfg_mc = replace(cfg, cubiomes_mc_enum=mc_enum)
        for entry in cal.get("seeds") or []:
            seed = str(entry["seed"])
            arena_raw = entry.get("arena") or {}
            center = arena_raw.get("center", [0, 0])
            arena = Arena(
                center=(int(center[0]), int(center[1])),
                radius=int(arena_raw.get("radius", 64)),
            )
            allow = entry.get("allow") or []
            scan = run_biome_scan(cfg_mc, arena, seed, step=step)
            if scan is None:
                rows.append({"mc_enum": mc_enum, "seed": seed, "error": "no binary"})
                continue
            frac = scan.fraction_in_allow(
                [f"minecraft:{b}" if not str(b).startswith("minecraft:") else b for b in allow]
            )
            rows.append(
                {
                    "mc_enum": mc_enum,
                    "seed": seed,
                    "allow_fraction": round(frac, 4),
                    "distinct": len(scan.distinct_biomes()),
                    "histogram": {k.split(":")[-1]: v for k, v in scan.histogram().items()},
                }
            )
    return rows


def run_calibration(cfg: ServerConfig, cal_path: Path) -> CalibrateReport:
    cal = load_calibration(cal_path)
    step = int(cal.get("step", 16))
    results: list[dict[str, Any]] = []
    all_ok = True

    for entry in cal.get("seeds") or []:
        seed = str(entry["seed"])
        arena_raw = entry.get("arena") or {}
        center = arena_raw.get("center", [0, 0])
        arena = Arena(
            center=(int(center[0]), int(center[1])),
            radius=int(arena_raw.get("radius", 64)),
        )
        allow = entry.get("allow") or []
        min_frac = float(entry.get("allow_min_fraction", 0.0))

        scan = run_biome_scan(cfg, arena, seed, step=step)
        if scan is None:
            results.append({"seed": seed, "ok": False, "error": "cubiomes binary missing"})
            all_ok = False
            continue

        frac = scan.fraction_in_allow(
            [f"minecraft:{b}" if not str(b).startswith("minecraft:") else b for b in allow]
        )
        ok = frac >= min_frac
        if not ok:
            all_ok = False
        results.append(
            {
                "seed": seed,
                "ok": ok,
                "cell_count": scan.cell_count,
                "allow_fraction": round(frac, 4),
                "distinct": len(scan.distinct_biomes()),
                "histogram": scan.histogram(),
            }
        )

    return CalibrateReport(ok=all_ok, results=results)
