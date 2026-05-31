"""Weighted scoring for multi-candidate selection (M2)."""

from __future__ import annotations

from typing import Any


def _get(d: dict[str, Any], path: str, default: float = 0.0) -> float:
    cur: Any = d
    for part in path.split("."):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part)
    if cur is None:
        return default
    try:
        return float(cur)
    except (TypeError, ValueError):
        return default


def score_report(report: dict[str, Any], weights: dict[str, float]) -> float:
    """Higher is better. Keys are dot paths into report metrics."""
    total = 0.0
    wsum = 0.0
    m = report.get("metrics") or report.get("metrics_by_shape") or {}
    flat = {
        "prep.largest_flat_area": _get(m, "prep.largest_flat_area"),
        "prep.grass_pct": _get(m, "prep.grass_pct"),
        "survey.unique_biome_count": _get(m, "survey.unique_biome_count"),
        "transit.terrain_difficulty": _get(m, "transit.terrain_difficulty"),
        "transit.water_pct": _get(m, "transit.water_pct"),
        "work.coal_ore_samples": _get(m, "work.coal_ore_samples"),
        "work.iron_ore_samples": _get(m, "work.iron_ore_samples"),
        "work.chicken_count": _get(m, "work.chicken_count"),
        "closeout.return_flat_area": _get(m, "closeout.return_flat_area"),
    }
    minimize = {"transit.terrain_difficulty", "transit.water_pct"}
    for key, w in weights.items():
        if w == 0:
            continue
        val = flat.get(key, _get(m, key.replace("metrics.", "")))
        if key in minimize:
            val = max(0.0, 1.0 - min(val, 1.0)) if val <= 1 else 1.0 / (1.0 + val)
        total += w * val
        wsum += abs(w)
    return round(total / wsum, 6) if wsum else 0.0


def rank_reports(
    reports: list[dict[str, Any]],
    weights: dict[str, float],
) -> list[tuple[float, dict[str, Any]]]:
    scored = [(score_report(r, weights), r) for r in reports]
    scored.sort(key=lambda t: t[0], reverse=True)
    return scored
