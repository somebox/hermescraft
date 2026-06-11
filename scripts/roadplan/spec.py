"""Walkability spec loader — Python side of the single-source contract.

Mirrors bot/lib/shared/walkability-spec.js. Both load
data/walkability-spec.json; neither re-declares thresholds inline.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = REPO_ROOT / "data" / "walkability-spec.json"

REQUIRED_NUMERIC = (
    "max_step_up",
    "max_unguarded_drop",
    "clearance_height",
    "path_width",
    "shoulder_width",
    "fill_shallow_max_depth",
    "no_floor_min_depth",
    "max_bridge",
    "torch_spacing_max",
)


def _validate(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("walkability-spec.json: top-level must be an object")
    for key in REQUIRED_NUMERIC:
        if not isinstance(data.get(key), (int, float)) or isinstance(data.get(key), bool):
            raise ValueError(f'walkability-spec.json: missing or non-numeric "{key}"')
    ff = data.get("forbidden_floor")
    if not isinstance(ff, list) or not all(isinstance(b, str) for b in ff):
        raise ValueError('walkability-spec.json: "forbidden_floor" must be a list of block names')
    return data


@lru_cache(maxsize=1)
def load_spec(path: str | None = None) -> dict:
    p = Path(path) if path else SPEC_PATH
    return _validate(json.loads(p.read_text()))
