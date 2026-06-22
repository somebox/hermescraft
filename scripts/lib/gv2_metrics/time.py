from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def extract_time(config: dict, board: list[dict]) -> dict:
    start = _parse_iso(config.get("started_at"))
    end = _parse_iso(config.get("ended_at"))
    wall_s = None
    if start and end:
        wall_s = max(0, int((end - start).total_seconds()))
    done = sum(1 for t in board if (t.get("status") or "").lower() in ("done", "archived"))
    total = len(board)
    cph = None
    if wall_s and wall_s > 0:
        cph = round(done / (wall_s / 3600.0), 3)
    return {
        "run_wall_s": wall_s,
        "cards_done": done,
        "cards_total": total,
        "cards_per_hour": cph,
    }
