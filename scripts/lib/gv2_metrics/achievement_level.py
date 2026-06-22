from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parents[3]
LEVELS_PATH = REPO / "config" / "gv2-achievement-levels.yaml"
LEVEL_ORDER = ["G0", "G1", "G2", "G3", "G4", "G5"]


def _get_metric(metrics: dict, key: str) -> Any:
    cur: Any = metrics
    for part in key.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _eval_pred(value: Any, op: str, target: float) -> bool:
    if op == "eq" and target is True:
        return bool(value) is True
    if op == "eq" and target is False:
        return bool(value) is False
    if value is None:
        return False
    if op == "min":
        return float(value) >= target
    if op == "max":
        return float(value) <= target
    if op == "eq":
        return value == target
    return False


def load_levels(path: Path | None = None) -> dict:
    p = path or LEVELS_PATH
    return yaml.safe_load(p.read_text()) if p.is_file() else {"levels": {}}


def evaluate_achievement_level(metrics: dict, summary: dict, tier: str, levels: dict | None = None) -> dict:
    cfg = levels or load_levels()
    tier = tier or "standard"
    missing: list[str] = []
    if metrics.get("production", {}).get("food_ratio") is None and _needs_chest(cfg, tier):
        missing.append("artifacts/world/chest-snapshots.json")

    current = "G0"
    gaps: list[str] = []
    failed: list[str] = []
    for level in LEVEL_ORDER:
        spec = (cfg.get("levels") or {}).get(level) or {}
        preds = spec.get("predicates") or []
        level_ok = True
        for pred in preds:
            key = pred.get("metric")
            op = pred.get("op", "min")
            val = pred.get("value")
            overrides = pred.get("tier_overrides") or {}
            if tier in overrides:
                val = overrides[tier]
            if val is None:
                continue
            mv = _get_metric({**metrics, **summary}, key)
            if mv is None and key.startswith("achievement."):
                mv = _get_metric(summary, key.replace("achievement.", "operational.", 1))
            if not _eval_pred(mv, op, float(val)):
                level_ok = False
                failed.append(f"{level}:{key}:{op}:{val}")
                gaps.append(f"{key} {mv} vs {op} {val}")
        if level_ok:
            current = level
        else:
            break

    idx = LEVEL_ORDER.index(current)
    next_level = LEVEL_ORDER[min(idx + 1, len(LEVEL_ORDER) - 1)]
    target = summary.get("target_achievement_level") or next_level
    return {
        "current": current,
        "next": next_level,
        "target": target,
        "tier": tier,
        "gaps": gaps[:8],
        "failed_predicates": failed[:12],
        "missing_evidence": missing,
    }


def _needs_chest(cfg: dict, tier: str) -> bool:
    for level in ("G3", "G4", "G5"):
        for pred in (cfg.get("levels") or {}).get(level, {}).get("predicates") or []:
            if "food_ratio" in (pred.get("metric") or ""):
                return True
    return False
