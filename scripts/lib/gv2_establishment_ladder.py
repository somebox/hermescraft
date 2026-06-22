"""Genesis-v2 establishment ladder (0–6 milestones, offline from run artifacts)."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
MILESTONE_KEYS = ("site", "ground", "shell", "chest", "food", "mine")
Status = str  # yes | partial | no


def _load_json(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _mark_names(locations: dict | list | None) -> list[str]:
    if locations is None:
        return []
    if isinstance(locations, list):
        return [str(x.get("name") or x) for x in locations if isinstance(x, dict)]
    if isinstance(locations, dict):
        marks = locations.get("marks") or locations.get("locations") or locations
        if isinstance(marks, dict):
            return list(marks.keys())
        if isinstance(marks, list):
            return [str(x.get("name") or x) for x in marks if isinstance(x, dict)]
    return []


def _board_tasks(board: list | dict | None) -> list[dict]:
    if board is None:
        return []
    if isinstance(board, list):
        return [t for t in board if isinstance(t, dict)]
    return list(board.get("tasks") or [])


def _jsonl_verbs(artifact_dir: Path) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for jl in sorted(artifact_dir.glob("actions-*.jsonl")):
        for line in jl.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            verb = str(row.get("action") or "")
            status = str(row.get("status") or "")
            out.append((verb, status))
    return out


def _food_ratio_from_snapshots(chest_snapshots: dict | None, goals_path: Path) -> float | None:
    if not chest_snapshots:
        return None
    try:
        import yaml
    except ImportError:
        return None
    goals = yaml.safe_load(goals_path.read_text()) if goals_path.is_file() else {}
    food = goals.get("food") or {}
    items = set(food.get("items") or [])
    target = float(food.get("target_min") or 1)
    total = 0
    for _mark, snap in (chest_snapshots.get("chests") or chest_snapshots).items():
        if not isinstance(snap, dict):
            continue
        inv = snap.get("items") or snap.get("inventory") or {}
        if isinstance(inv, list):
            for slot in inv:
                if isinstance(slot, dict) and slot.get("name") in items:
                    total += int(slot.get("count") or 0)
        elif isinstance(inv, dict):
            for name, count in inv.items():
                if name in items:
                    total += int(count or 0)
    return min(1.0, total / target) if target > 0 else None


def evaluate_milestones(
    *,
    config: dict | None,
    locations: dict | None,
    regions: dict | None,
    mines: dict | None,
    board: list | dict | None,
    artifact_dir: Path | None,
    chest_snapshots: dict | None = None,
    goals_path: Path | None = None,
) -> dict:
    """Return score dict: score, max, milestones, evidence, source."""
    cfg = config or {}
    marks = _mark_names(locations)
    tasks = _board_tasks(board)
    verbs = _jsonl_verbs(artifact_dir) if artifact_dir and artifact_dir.is_dir() else []
    goals_path = goals_path or REPO / "data" / "base-goals.yaml"

    evidence: dict[str, list[str]] = {k: [] for k in MILESTONE_KEYS}
    milestones: dict[str, Status] = {}

    # site
    site_yes = any(
        n == "base_anchor" or n.startswith("candidate_") for n in marks
    ) or any(
        "[SCOUT]" in (t.get("title") or "") or "[SURVEY]" in (t.get("title") or "")
        for t in tasks
        if (t.get("status") or "").lower() in ("done", "archived")
    )
    site_partial = bool(marks) and not site_yes
    if site_yes:
        milestones["site"] = "yes"
        for n in marks:
            if n == "base_anchor" or n.startswith("candidate_"):
                evidence["site"].append(f"mark:{n}")
    elif site_partial:
        milestones["site"] = "partial"
        evidence["site"].append(f"marks:{len(marks)}")
    else:
        milestones["site"] = "no"

    # ground
    ground_yes = bool(cfg.get("shelter_rendered")) or any(
        n.startswith(("pad_", "foundation_")) for n in marks
    ) or any(v in ("place_fill", "fill") and s == "ok" for v, s in verbs)
    ground_partial = bool(cfg.get("shelter_rendered")) and not ground_yes
    if ground_yes:
        milestones["ground"] = "yes"
        if cfg.get("shelter_rendered"):
            evidence["ground"].append("config:shelter_rendered")
        for n in marks:
            if n.startswith(("pad_", "foundation_")):
                evidence["ground"].append(f"mark:{n}")
    elif ground_partial:
        milestones["ground"] = "partial"
    else:
        milestones["ground"] = "no"

    # shell
    reg_list = []
    if isinstance(regions, dict):
        reg_list = regions.get("regions") or list(regions.values()) if "regions" not in regions else []
    shell_yes = any(
        isinstance(r, dict) and r.get("profile") == "base" for r in (reg_list if isinstance(reg_list, list) else [])
    ) or any(n.startswith(("base_", "wall_", "roof_")) for n in marks) or any(
        "[CONSTRUCT]" in (t.get("title") or "")
        and any(x in (t.get("title") or "").lower() for x in ("shelter", "shell"))
        and (t.get("status") or "").lower() in ("done", "archived")
        for t in tasks
    )
    shell_partial = any(n.startswith(("base_", "wall_", "roof_")) for n in marks) and not shell_yes
    if shell_yes:
        milestones["shell"] = "yes"
    elif shell_partial:
        milestones["shell"] = "partial"
    else:
        milestones["shell"] = "no"

    # chest
    chest_marks = [n for n in marks if n.startswith("chest_")]
    snap_count = 0
    if chest_snapshots:
        chests = chest_snapshots.get("chests") or chest_snapshots
        if isinstance(chests, dict):
            snap_count = len(chests)
    if len(chest_marks) >= 2 or snap_count >= 2:
        milestones["chest"] = "yes"
        evidence["chest"].extend(f"mark:{n}" for n in chest_marks[:3])
    elif len(chest_marks) == 1 or snap_count == 1:
        milestones["chest"] = "partial"
    else:
        milestones["chest"] = "no"

    # food
    ratio = _food_ratio_from_snapshots(chest_snapshots, goals_path)
    food_deposit = any(v in ("deposit", "withdraw", "collect") and s == "ok" for v, s in verbs)
    if ratio is not None and ratio >= 1.0:
        milestones["food"] = "yes"
        evidence["food"].append(f"ratio:{ratio:.2f}")
    elif ratio is not None and ratio > 0:
        milestones["food"] = "partial"
        evidence["food"].append(f"ratio:{ratio:.2f}")
    elif food_deposit:
        milestones["food"] = "partial"
        evidence["food"].append("jsonl:deposit_ok")
    else:
        milestones["food"] = "no"

    # mine
    mine_yes = any(n.startswith(("mine_", "lt_")) for n in marks) or bool(mines)
    mine_done = any(
        "[MINE]" in (t.get("title") or "") and (t.get("status") or "").lower() in ("done", "archived")
        for t in tasks
    )
    mine_verb = any(v in ("dig", "collect", "goto", "go_mark") and s == "ok" for v, s in verbs)
    if mine_yes and (mine_done or mine_verb):
        milestones["mine"] = "yes"
        evidence["mine"].extend(
            f"mark:{n}" for n in marks if n.startswith(("mine_", "lt_"))
        )
    elif mine_yes or mine_done:
        milestones["mine"] = "partial"
    else:
        milestones["mine"] = "no"

    weights = {"yes": 1.0, "partial": 0.5, "no": 0.0}
    score = sum(weights[milestones[k]] for k in MILESTONE_KEYS)
    source = "artifacts" if locations is not None else "live_marks"
    return {
        "score": round(score, 2),
        "max": 6,
        "milestones": milestones,
        "evidence": evidence,
        "source": source,
    }


def evaluate_run_dir(run_root: Path, *, live_marks: bool = False) -> dict:
    run_root = Path(run_root)
    config = _load_json(run_root / "config.json") or {}
    art = run_root / "artifacts"
    world = art / "world"
    locations = _load_json(world / "locations-base.json")
    if locations is None and live_marks:
        locations = _load_json(REPO / "data" / "locations-base.json")
    regions = _load_json(world / "regions-world.json")
    if regions is None and live_marks:
        regions = _load_json(REPO / "data" / "regions-world.json")
    mines = None
    for p in sorted(world.glob("mines-*.json")) if world.is_dir() else []:
        mines = _load_json(p)
        break
    board = _load_json(art / "board.json")
    chest_snapshots = _load_json(world / "chest-snapshots.json")
    return evaluate_milestones(
        config=config,
        locations=locations,
        regions=regions,
        mines=mines,
        board=board,
        artifact_dir=art if art.is_dir() else None,
        chest_snapshots=chest_snapshots,
    )


def format_one_line(result: dict) -> str:
    ms = result.get("milestones") or {}
    parts = " ".join(f"{k}={ms.get(k, 'no')}" for k in MILESTONE_KEYS)
    return f"establishment: score={result.get('score')}/{result.get('max')} {parts}"
