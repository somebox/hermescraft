#!/usr/bin/env python3
"""Process grader for the mapping mission.

Companion to establish-check.py — that one checks for a cobble pad + base
anchor; this one checks for in-world named places + personal-POI coverage.

Reads data/personal-pois-shared.json (NOT locations-base.json — the two
stores are deliberately separate; conflating them defeats the mapping
mission's "private POIs reconciled into a shared overlay" design).

Metrics
-------
poi_count          total POIs in the shared overlay
sign_count         POIs whose sign_at is non-null (= signs placed in-world)
torch_count        POIs whose torch_at is non-null
coverage_radius    max horizontal distance from muster of any POI
quadrant_coverage  dict {"NE": n, "NW": n, "SE": n, "SW": n}
distinct_kinds     count of distinct `kind` values across POIs
epic_status        "[MAP:ARENA]" epic state from the kanban DB

Thresholds (initial; tune after first run)
  ok = poi_count >= 8
       AND sign_count >= 4
       AND coverage_radius >= 40
       AND at least 3 of 4 quadrants have >= 1 POI
       AND epic_status == "done"
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
EPIC_TAG = "[MAP:ARENA]"
DEFAULT_BOARD = "landfolk-ops"


def kanban_db() -> Path:
    board = os.environ.get("HERMES_KANBAN_BOARD", DEFAULT_BOARD)
    explicit = os.environ.get("HERMES_KANBAN_DB")
    if explicit:
        return Path(explicit).expanduser()
    return Path.home() / ".hermes" / "kanban" / "boards" / board / "kanban.db"


def load_shared_pois() -> dict:
    """Read the reconciled overlay only. Per-bot files are intentionally
    NOT merged here: only POIs the fleet has agreed on (via reconcile-pois.py
    or single-bot uncontested promotion) count toward grading.
    """
    p = DATA / "personal-pois-shared.json"
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def load_muster() -> tuple[int, int, int] | None:
    """Muster lives on the last-establish map JSON. Without it we can still
    grade poi_count + sign_count, but `coverage_radius` and `quadrant_coverage`
    can't be computed."""
    rt = DATA / "runtime" / "last-establish-map.json"
    if not rt.exists():
        return None
    try:
        card = json.loads(rt.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    placements = card.get("placements") or {}
    raw = card.get("muster") or placements.get("muster")
    if not raw or len(raw) < 3:
        return None
    return int(raw[0]), int(raw[1]), int(raw[2])


def quadrant_of(px: int, pz: int, mx: int, mz: int) -> str:
    """Quadrant relative to muster, axis-aligned (north = -z, east = +x)."""
    dx = px - mx
    dz = pz - mz
    if dx >= 0 and dz < 0:
        return "NE"
    if dx < 0 and dz < 0:
        return "NW"
    if dx >= 0 and dz >= 0:
        return "SE"
    return "SW"


def find_map_epic(conn: sqlite3.Connection) -> sqlite3.Row | None:
    conn.row_factory = sqlite3.Row
    for row in conn.execute("SELECT id, title, status FROM tasks"):
        if EPIC_TAG in (row["title"] or ""):
            return row
    return None


def grade(pois: dict, muster: tuple[int, int, int] | None,
          *, poi_target: int, sign_target: int, coverage_min: int,
          quadrant_min: int, epic_status: str | None) -> dict:
    failures: list[str] = []

    poi_count = len(pois)
    sign_count = sum(1 for p in pois.values()
                     if isinstance(p, dict) and p.get("sign_at"))
    torch_count = sum(1 for p in pois.values()
                      if isinstance(p, dict) and p.get("torch_at"))
    distinct_kinds = len({
        p.get("kind") for p in pois.values()
        if isinstance(p, dict) and p.get("kind")
    })

    coverage_radius = None
    quadrant_coverage: dict[str, int] = {"NE": 0, "NW": 0, "SE": 0, "SW": 0}
    if muster is not None:
        mx, _my, mz = muster
        max_dist = 0
        for p in pois.values():
            if not isinstance(p, dict):
                continue
            try:
                px, pz = int(p["x"]), int(p["z"])
            except (KeyError, TypeError, ValueError):
                continue
            d = math.hypot(px - mx, pz - mz)
            if d > max_dist:
                max_dist = d
            quadrant_coverage[quadrant_of(px, pz, mx, mz)] += 1
        coverage_radius = int(round(max_dist))

    if poi_count < poi_target:
        failures.append(f"poi_count {poi_count} < {poi_target}")
    if sign_count < sign_target:
        failures.append(f"sign_count {sign_count} < {sign_target}")
    if coverage_radius is None:
        failures.append("coverage_radius unavailable (missing muster)")
    elif coverage_radius < coverage_min:
        failures.append(f"coverage_radius {coverage_radius} < {coverage_min}")
    quadrants_with_any = sum(1 for v in quadrant_coverage.values() if v > 0)
    if muster is not None and quadrants_with_any < quadrant_min:
        failures.append(
            f"quadrant coverage {quadrants_with_any} of 4 < {quadrant_min}"
        )
    if epic_status is None:
        failures.append(f"no epic with {EPIC_TAG!r} on board")
    elif epic_status != "done":
        failures.append(f"epic status={epic_status!r}, want 'done'")

    return {
        "ok": not failures,
        "poi_count": poi_count,
        "sign_count": sign_count,
        "torch_count": torch_count,
        "distinct_kinds": distinct_kinds,
        "coverage_radius": coverage_radius,
        "quadrant_coverage": quadrant_coverage,
        "epic_status": epic_status,
        "failures": failures,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--poi-min", type=int, default=8)
    ap.add_argument("--sign-min", type=int, default=4)
    ap.add_argument("--coverage-min", type=int, default=40,
                    help="Minimum coverage_radius (max horizontal distance "
                         "from muster of any POI)")
    ap.add_argument("--quadrant-min", type=int, default=3,
                    help="Minimum number of quadrants (of 4) with >= 1 POI")
    ap.add_argument("--skip-epic", action="store_true",
                    help="Skip the kanban epic-status check (offline / mid-run)")
    args = ap.parse_args()

    pois = load_shared_pois()
    muster = load_muster()

    epic_status: str | None
    if args.skip_epic:
        epic_status = "done"  # treat as satisfied for offline grading
    else:
        db_path = kanban_db()
        if not db_path.exists():
            print(f"FAIL: no kanban db at {db_path}", file=sys.stderr)
            return 1
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        epic = find_map_epic(conn)
        epic_status = epic["status"] if epic else None

    report = grade(
        pois, muster,
        poi_target=args.poi_min,
        sign_target=args.sign_min,
        coverage_min=args.coverage_min,
        quadrant_min=args.quadrant_min,
        epic_status=epic_status,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
