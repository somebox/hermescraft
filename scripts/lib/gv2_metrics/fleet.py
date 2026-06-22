from __future__ import annotations

from pathlib import Path

from scripts.lib.action_log_metrics import load_jsonl_entries


def _bots_from_artifact_dir(artifact_dir: Path) -> list[str]:
    bots: list[str] = []
    for jl in sorted(artifact_dir.glob("actions-*.jsonl")):
        stem = jl.stem  # actions-colony-scout
        if stem.startswith("actions-"):
            name = stem[len("actions-") :]
            if name and name not in bots:
                bots.append(name)
    return bots


def extract_fleet(artifact_dir, wall_s: int | None) -> dict:
    entries = load_jsonl_entries(artifact_dir)
    bots_used = _bots_from_artifact_dir(Path(artifact_dir))
    if not entries:
        return {"active_mc_pct": None, "bots_used": bots_used}
    times = []
    for e in entries:
        try:
            times.append((int(e["started_at"]), int(e["finished_at"])))
        except (KeyError, TypeError, ValueError):
            continue
    if not times or not wall_s:
        return {"active_mc_pct": None, "bots_used": bots_used}
    active = sum(max(0, b - a) for a, b in times)
    pct = round(100.0 * active / (wall_s * 1000), 1) if wall_s else None
    return {"active_mc_pct": pct, "bots_used": bots_used}
