"""Build acceptance predicate lists from graph metadata / farm_plan."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from .constants import DISCOVERY_MIN_WHEAT, WHEAT_CHEST_MIN_COUNT


def outcome_only_chest(*, mark: str = "wheat_chest", min_count: int = DISCOVERY_MIN_WHEAT) -> list[dict]:
    return [{
        "kind": "chest_contains",
        "mark": mark,
        "item": "wheat",
        "min_count": min_count,
    }]


def from_farm_plan(farm_plan: dict, *, default_min: int = DISCOVERY_MIN_WHEAT) -> list[dict]:
    preds: list[dict] = []
    deposit = farm_plan.get("deposit_mark") or "wheat_chest"
    min_wheat = int(farm_plan.get("min_wheat") or default_min)
    preds.append({
        "kind": "chest_contains",
        "mark": deposit,
        "item": "wheat",
        "min_count": min_wheat,
    })
    water_mark = farm_plan.get("water_mark")
    if water_mark:
        preds.append({"kind": "at_mark", "mark": water_mark, "block": "water"})
    c1 = farm_plan.get("plot_corner1")
    c2 = farm_plan.get("plot_corner2")
    target = farm_plan.get("target_farmland_cells")
    if c1 and c2 and target:
        margin = max(0, int(target) - 8)
        preds.append({
            "kind": "region_blocks",
            "corner1": c1,
            "corner2": c2,
            "block": "farmland",
            "min_count": margin,
        })
    return preds


def resolve_for_evaluate(
    manifest: dict,
    trial_dir: Path,
) -> list[dict]:
    graph = manifest.get("graph", "capstone")
    if graph == "discovery":
        fp = trial_dir / "farm_plan.json"
        if fp.is_file():
            plan = json.loads(fp.read_text())
            inner = plan.get("farm_plan", plan)
            return from_farm_plan(inner)
        return outcome_only_chest(
            mark=manifest.get("deposit_mark", "wheat_chest"),
            min_count=int(manifest.get("min_wheat", DISCOVERY_MIN_WHEAT)),
        )
    stored = manifest.get("acceptance_predicates") or []
    if stored:
        return list(stored)
    sp = manifest.get("acceptance_predicate")
    if sp:
        return [sp]
    return outcome_only_chest(min_count=WHEAT_CHEST_MIN_COUNT)
