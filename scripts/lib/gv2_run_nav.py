"""Build run-nav.json (prev/next/same_arm) for gv2 run dashboards."""
from __future__ import annotations

import json
from pathlib import Path

import genesis2_lib as g2


def _load_config(run_dir: Path) -> dict | None:
    p = run_dir / "config.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _run_dirs(runs_root: Path) -> list[Path]:
    return sorted(
        (p for p in runs_root.iterdir() if p.is_dir() and p.name.startswith("gv2-")),
        key=lambda p: p.name,
    )


def build_run_nav(run_root: Path, config: dict | None = None) -> dict:
    """Navigation manifest for one scored run (plan: prev/next/baseline/same_arm)."""
    run_root = run_root.resolve()
    cfg = config or _load_config(run_root) or {}
    run_id = cfg.get("run_id") or run_root.name
    runs_root = g2.runs_root().resolve()
    arm = (cfg.get("evidence_arm") or "").strip()
    tier = cfg.get("tier") or "standard"

    chronological: list[tuple[str, str]] = []
    same_arm: list[str] = []
    for p in _run_dirs(runs_root):
        c = _load_config(p)
        if not c:
            continue
        started = c.get("started_at") or p.name
        chronological.append((started, p.name))
        if arm and (c.get("evidence_arm") or "").strip() == arm:
            same_arm.append(p.name)
    chronological.sort(key=lambda x: x[0])
    ordered_ids = [rid for _, rid in chronological]
    same_arm.sort(key=lambda rid: next((t for t, i in chronological if i == rid), rid))

    prev_id: str | None = None
    next_id: str | None = None
    if run_id in ordered_ids:
        i = ordered_ids.index(run_id)
        if i > 0:
            prev_id = ordered_ids[i - 1]
        if i + 1 < len(ordered_ids):
            next_id = ordered_ids[i + 1]

    return {
        "run_id": run_id,
        "evidence_arm": arm or None,
        "tier": tier,
        "prev_run_id": prev_id,
        "next_run_id": next_id,
        "baseline_run_id": cfg.get("validation_baseline_run_id"),
        "same_arm_runs": same_arm if arm else ordered_ids[-20:],
    }
