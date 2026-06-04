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
from datetime import datetime, timezone
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


def _load_graph_module():
    """Import scripts/poi-graph.py (hyphenated → not a package name)."""
    import importlib.util
    from pathlib import Path as _P
    spec = importlib.util.spec_from_file_location(
        "poi_graph", _P(__file__).resolve().parent / "poi-graph.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def grade(pois: dict, muster: tuple[int, int, int] | None,
          *, poi_target: int, sign_target: int, coverage_min: int,
          quadrant_min: int, epic_status: str | None,
          frontier_max: int = 3, max_edge_step: float = 30.0) -> dict:
    """Phase E grader.

    coverage_min is reinterpreted as `longest_path_len` (the map's
    spine), not `coverage_radius` — the path-construction mission cares
    about how long a torch-lit trail you can walk, not how far any one
    POI is from muster.

    `frontier_max` caps the number of named POIs allowed to be
    frontier nodes (degree <= 1). Below this many is "most landmarks are
    connected".
    """
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

    # Build the graph in-process (no subprocess; share the helper module).
    pg = _load_graph_module()
    nodes = pg.build_nodes(pois)
    edges = pg.build_edges(nodes, max_edge_step)
    components = pg.find_components(nodes, edges)
    quads_per_comp = pg.quadrants_per_component(nodes, components, muster)
    longest_path, longest_path_len = pg.longest_path(nodes, edges)
    fr = pg.frontier_nodes(nodes, edges)
    named_names = {n["name"] for n in nodes if n["named"]}
    named_count = len(named_names)
    named_frontier = sorted(name for name in fr if name in named_names)

    # Union of quadrants touched across all components
    quadrant_union: set[str] = set()
    for q in quads_per_comp:
        quadrant_union.update(q)

    if poi_count < poi_target:
        failures.append(f"poi_count {poi_count} < {poi_target}")
    if sign_count < sign_target:
        failures.append(f"sign_count (named landmarks) {sign_count} < {sign_target}")
    if longest_path_len < coverage_min:
        failures.append(f"longest_path_len {longest_path_len} < {coverage_min}")
    if muster is None:
        failures.append("muster unavailable — cannot compute quadrant coverage")
    elif len(quadrant_union) < quadrant_min:
        failures.append(
            f"quadrant coverage {len(quadrant_union)} of 4 < {quadrant_min}"
        )
    if len(named_frontier) > frontier_max:
        failures.append(
            f"named_frontier_count {len(named_frontier)} > {frontier_max} "
            f"(too many isolated landmarks)"
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
        "named_count": named_count,
        "longest_path_len": longest_path_len,
        "longest_path": longest_path,
        "named_frontier": named_frontier,
        "component_count": len(components),
        "quadrant_union": sorted(quadrant_union),
        "epic_status": epic_status,
        "failures": failures,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--poi-min", type=int, default=6,
                    help="Minimum named-landmark POI count")
    ap.add_argument("--sign-min", type=int, default=6,
                    help="Minimum POIs with non-null sign_at (= same as named "
                         "landmarks in Phase E)")
    ap.add_argument("--coverage-min", type=int, default=80,
                    help="Minimum longest_path_len (= length of the longest "
                         "torch-lit trail through the named-POI graph, in "
                         "blocks)")
    ap.add_argument("--quadrant-min", type=int, default=4,
                    help="Minimum quadrants (of 4) touched across the union "
                         "of connected components")
    ap.add_argument("--frontier-max", type=int, default=3,
                    help="Maximum named POIs allowed to be frontier nodes "
                         "(degree <= 1). Below = most landmarks connected.")
    ap.add_argument("--max-edge-step", type=float, default=30.0,
                    help="POI-graph edge threshold; two POIs are adjacent if "
                         "their anchor coords are within this many blocks")
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
        frontier_max=args.frontier_max,
        max_edge_step=args.max_edge_step,
    )
    runtime_dir = DATA / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    grade_path = runtime_dir / "last-mapping-grade.json"
    payload = {
        **report,
        "graded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    grade_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
