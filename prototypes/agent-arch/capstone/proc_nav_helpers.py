"""Shared proc-nav map anchors, scorecard verb counts, acceptance predicates."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

REPO_RUNTIME_MAP = Path("data/runtime/last-scenario-map.json")

MC_VERB_RE = re.compile(
    r"\bmc\s+(status|scene|move|goto|go_mark|inspect|marks|verify|escape|"
    r"reachable|build_stairs|dig|nearby)\b",
    re.I,
)


def load_map_card(path: Path | None = None) -> dict[str, Any]:
    p = path or REPO_RUNTIME_MAP
    if not p.is_file():
        return {}
    data = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(data, dict) and data.get("ok") is False:
        return {}
    return data if isinstance(data, dict) else {}


def anchor_xyz(card: dict, name: str) -> list[int] | None:
    placements = card.get("placements") or {}
    raw = placements.get(name) or card.get(name)
    if not isinstance(raw, (list, tuple)) or len(raw) < 3:
        return None
    return [int(raw[0]), int(raw[1]), int(raw[2])]


def acceptance_predicates_from_map(
    card: dict,
    *,
    marks: tuple[str, ...] = ("overlook", "return_post"),
) -> list[dict]:
    """Tester `at_mark` checks after prep-proc-scout-marks."""
    preds: list[dict] = []
    for mark in marks:
        if anchor_xyz(card, mark) is not None:
            preds.append({"kind": "at_mark", "mark": mark, "near": 4})
    return preds


def count_mc_verbs_from_text(text: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for m in MC_VERB_RE.finditer(text):
        verb = m.group(1).lower()
        if verb == "go_mark":
            verb = "go_mark"
        counts[verb] = counts.get(verb, 0) + 1
    return counts


def merge_verb_counts(*dicts: dict[str, int]) -> dict[str, int]:
    out: dict[str, int] = {}
    for d in dicts:
        for k, v in d.items():
            out[k] = out.get(k, 0) + v
    return out


def load_thresholds(repo_root: Path) -> dict:
    path = repo_root / "calibration" / "proc-nav-thresholds.yaml"
    if not path.is_file():
        return {}
    try:
        import yaml  # type: ignore

        return yaml.safe_load(path.read_text()) or {}
    except Exception:
        return {}


def tier_from_graph(graph: str) -> str:
    if graph == "proc-scout-road":
        return "road"
    if graph == "proc-scout-stress":
        return "stress"
    if graph in ("proc-scout",):
        return "core"
    return "baseline"
