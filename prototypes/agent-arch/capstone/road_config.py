"""Load proc-nav road corridor config from calibration/proc-nav-road.yaml."""

from __future__ import annotations

from pathlib import Path
from typing import Any

_REPO = Path(__file__).resolve().parents[3]
_DEFAULT = _REPO / "calibration" / "proc-nav-road.yaml"

# Agent-placed interior boundaries (not in mapcatalog).
ROAD_BOUND_PREFIX = "road_bound_"


def load_road_config(path: Path | None = None) -> dict[str, Any]:
    import yaml

    p = path or _DEFAULT
    if not p.is_file():
        return {
            "endpoints": ["overlook", "return_post"],
            "segment_count": 1,
            "segment_length_blocks": 6,
            "centerline_blocks": 6,
            "width_blocks": 3,
        }
    data = yaml.safe_load(p.read_text()) or {}
    endpoints = list(data.get("endpoints") or ["overlook", "return_post"])
    seg_n = int(data.get("segment_count", max(1, len(endpoints) - 1)))
    return {
        "endpoints": endpoints,
        "segment_count": seg_n,
        "segment_length_blocks": int(data.get("segment_length_blocks", 12)),
        "centerline_blocks": int(data.get("centerline_blocks", 48)),
        "width_blocks": int(data.get("width_blocks", 3)),
    }


def interior_bound_marks(segment_count: int) -> tuple[str, ...]:
    """Marks agents create along the corridor (not catalog-prep'd)."""
    if segment_count <= 1:
        return ()
    return tuple(f"{ROAD_BOUND_PREFIX}{i}" for i in range(1, segment_count))


def road_segments(cfg: dict[str, Any] | None = None) -> list[tuple[int, str, str]]:
    """Return [(segment_id, from_mark, to_mark), ...] for kanban cards."""
    c = cfg or load_road_config()
    n = int(c["segment_count"])
    endpoints: list[str] = c["endpoints"]
    start, end = endpoints[0], endpoints[-1]
    if n <= 1:
        return [(1, start, end)]
    out: list[tuple[int, str, str]] = []
    out.append((1, start, f"{ROAD_BOUND_PREFIX}1"))
    for i in range(2, n):
        out.append((i, f"{ROAD_BOUND_PREFIX}{i - 1}", f"{ROAD_BOUND_PREFIX}{i}"))
    out.append((n, f"{ROAD_BOUND_PREFIX}{n - 1}", end))
    return out


def all_mark_names_for_graph(cfg: dict[str, Any] | None = None) -> tuple[str, ...]:
    c = cfg or load_road_config()
    n = int(c["segment_count"])
    eps = tuple(c["endpoints"])
    return eps + interior_bound_marks(n)
