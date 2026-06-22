"""Append one row per scored run for trend charts (operator-local, gitignored)."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HISTORY = REPO / "data" / "genesis-v2-metrics-history.jsonl"


def append_metrics_history(scorecard: dict) -> None:
    s = scorecard.get("summary") or {}
    ach = s.get("achievement_level") or {}
    cmp_ = s.get("compare") or {}
    row = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "run_id": scorecard.get("run_id"),
        "overall": s.get("overall"),
        "achievement_level": ach.get("current"),
        "compare_safe": cmp_.get("compare_safe"),
        "overall_delta_vs_prev": cmp_.get("overall_delta_vs_prev"),
        "establishment_score": (s.get("achievement") or {}).get("establishment_score"),
        "food_ratio": (s.get("achievement") or {}).get("food_ratio"),
    }
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    with HISTORY.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")
