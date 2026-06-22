from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any


_LEVEL_OVERALL = {"G0": 28, "G1": 42, "G2": 55, "G3": 68, "G4": 82, "G5": 92}


def diff_scorecards(prev: dict, current: dict) -> dict[str, Any]:
    sp = prev.get("summary") or {}
    sc = current.get("summary") or {}
    mp = sp.get("achievement") or {}
    mc = sc.get("achievement") or {}
    op = sp.get("operational") or {}
    oc = sc.get("operational") or {}
    lp = (sp.get("achievement_level") or {}).get("current")
    lc = (sc.get("achievement_level") or {}).get("current")
    return {
        "overall_delta": (sc.get("overall") or 0) - (sp.get("overall") or 0),
        "establishment_delta": (mc.get("establishment_score") or 0) - (mp.get("establishment_score") or 0),
        "level_prev": lp,
        "level_current": lc,
        "wall_min_delta": (oc.get("wall_min") or 0) - (op.get("wall_min") or 0)
        if oc.get("wall_min") is not None and op.get("wall_min") is not None
        else None,
        "motor_errors_delta": (oc.get("motor_errors_scoped") or 0) - (op.get("motor_errors_scoped") or 0),
    }


def _git_commits_between(repo: Path, rev_start: str | None, rev_stop: str | None) -> list[str]:
    if not rev_start or not rev_stop or rev_start == rev_stop:
        return []
    try:
        r = subprocess.run(
            ["git", "log", "--oneline", f"{rev_start}..{rev_stop}"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=repo,
        )
        if r.returncode != 0:
            return []
        return [ln.strip() for ln in r.stdout.splitlines() if ln.strip()][:20]
    except (OSError, subprocess.TimeoutExpired):
        return []


def _config_diff(prev_cfg: dict, cfg: dict) -> list[str]:
    keys = (
        "seed",
        "spawn",
        "spawn_source",
        "worker_model",
        "planner_model",
        "tier",
        "evidence_arm",
        "loop_goal",
        "target_achievement_level",
    )
    out: list[str] = []
    for k in keys:
        a, b = prev_cfg.get(k), cfg.get(k)
        if a != b:
            out.append(f"{k}: {a!r} -> {b!r}")
    return out


def enrich_compare(
    *,
    config: dict,
    summary: dict,
    run_root: Path,
    repo_root: Path,
    achievement_level: dict | None = None,
) -> dict:
    """Fill compare block, what_changed, headline, overall from prev/baseline scorecards."""
    compare = summary.setdefault("compare", {})
    what = summary.setdefault("what_changed", {"repo_commits": [], "config_vs_prev": []})

    rev_start = config.get("repo_rev_at_start")
    rev_stop = config.get("repo_rev_at_stop")
    what["repo_commits"] = _git_commits_between(repo_root, rev_start, rev_stop)

    prev_id = config.get("prev_run_id")
    baseline_id = config.get("validation_baseline_run_id")
    runs_root = run_root.parent

    compare.setdefault("prev_run_id", config.get("prev_run_id"))
    compare.setdefault("baseline_run_id", baseline_id)

    def load_sc(rid: str | None) -> dict | None:
        if not rid:
            return None
        p = runs_root / rid / "scorecard.json"
        if not p.is_file():
            return None
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            return None

    prev_sc = load_sc(prev_id)
    base_sc = load_sc(baseline_id)

    level = (achievement_level or summary.get("achievement_level") or {}).get("current")
    if level:
        summary["overall"] = _LEVEL_OVERALL.get(level, summary.get("overall") or 50)
        summary["headline"] = f"Achievement {level} (overall {summary['overall']})"
        gaps = (achievement_level or {}).get("gaps") or []
        if gaps:
            summary["headline"] += f" — {gaps[0][:60]}"

    if prev_id and prev_sc:
        d = diff_scorecards(prev_sc, {"summary": summary})
        compare["overall_delta_vs_prev"] = d["overall_delta"]
        compare["establishment_delta_vs_prev"] = d["establishment_delta"]
        compare["level_prev"] = d["level_prev"]
        compare["level_current"] = d["level_current"]
        prev_cfg_path = runs_root / prev_id / "config.json"
        if prev_cfg_path.is_file():
            try:
                prev_cfg = json.loads(prev_cfg_path.read_text())
                what["config_vs_prev"] = _config_diff(prev_cfg, config)
            except (json.JSONDecodeError, OSError):
                pass
    elif prev_id:
        compare["note"] = (compare.get("note") or "") + f" prev scorecard missing for {prev_id}."

    if baseline_id and base_sc:
        d = diff_scorecards(base_sc, {"summary": summary})
        compare["overall_delta_vs_baseline"] = d["overall_delta"]

    return summary
