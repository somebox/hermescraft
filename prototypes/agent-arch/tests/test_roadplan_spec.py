"""Walkability spec — Python loader contract (Track F)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.spec import REQUIRED_NUMERIC, load_spec  # noqa: E402


def test_spec_loads_with_required_keys():
    spec = load_spec()
    for key in REQUIRED_NUMERIC:
        assert isinstance(spec[key], (int, float)), key
    assert spec["forbidden_floor"], "forbidden_floor must be non-empty"


def test_spec_invariants():
    spec = load_spec()
    assert spec["fill_shallow_max_depth"] < spec["no_floor_min_depth"]
    # max_bridge is the bridge-fill DEPTH — never fill deeper than a ravine.
    assert spec["max_bridge"] <= spec["no_floor_min_depth"]
    # max_bridge_span is the bridgeable WIDTH (creep-and-place) — independent
    # of depth, can exceed it.
    assert spec["max_bridge_span"] >= spec["max_bridge"]
    assert spec["max_step_up"] >= 1
    assert spec["path_width"] >= 1 and spec["clearance_height"] >= 2


def test_invalid_spec_rejected(tmp_path):
    bad = tmp_path / "spec.json"
    bad.write_text('{"version": 1, "max_step_up": "one"}')
    load_spec.cache_clear()
    with pytest.raises(ValueError):
        load_spec(str(bad))
    load_spec.cache_clear()
