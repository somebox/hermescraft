from __future__ import annotations

import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


def _food_ratio(chest_snapshots: dict | None) -> float | None:
    from scripts.lib.gv2_establishment_ladder import _food_ratio_from_snapshots

    return _food_ratio_from_snapshots(chest_snapshots, REPO / "data" / "base-goals.yaml")


def extract_production(run_root: Path) -> dict:
    world = run_root / "artifacts" / "world"
    chest = None
    p = world / "chest-snapshots.json"
    if p.is_file():
        chest = json.loads(p.read_text())
    food_ratio = _food_ratio(chest)
    return {
        "food_ratio": food_ratio,
        "production_critical_ok": food_ratio is not None and food_ratio >= 1.0,
        "by_resource": [],
        "withdrawable": None,
    }
