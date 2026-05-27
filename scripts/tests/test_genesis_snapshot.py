"""Snapshot schema presence."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis_lib as gl  # noqa: E402

SCHEMA_KEYS = frozenset(
    {
        "ts",
        "run_id",
        "elapsed_min",
        "seed",
        "difficulty",
        "base_anchor",
        "system_chest_at",
        "phase",
        "phase_completion",
        "resources",
        "marks",
        "kanban_events",
        "block_reasons",
        "phase_checks",
        "rescues",
        "findings",
        "poi_distance_min",
        "system_chest_usage",
    }
)


def test_snapshot_schema_keys(tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "RUNS_ROOT", tmp_path / "runs")
    rid = "g-2026-06-01-1"
    d = gl.ensure_run_layout(rid)
    cfg = {
        "run_id": rid,
        "seed": 99,
        "world": "world",
        "difficulty": None,
        "base_anchor": {"x": 0, "y": 64, "z": 0},
        "system_chest_at": {"x": 1, "y": 64, "z": -2},
        "started_at": "2026-06-01T12:00:00Z",
        "genesis_version": "abc",
    }
    gl.save_config(cfg)
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "genesis_snapshot", REPO / "scripts" / "genesis-snapshot.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    with patch("genesis_lib._kanban_list", return_value=[]):
        with patch("genesis_lib._run") as mock_run:
            mock_run.return_value = type(
                "R", (), {"returncode": 0, "stdout": "{}", "stderr": ""}
            )()
            with patch.object(sys, "argv", ["genesis-snapshot.py", "--run-id", rid, "--label", "start"]):
                spec.loader.exec_module(mod)
                assert mod.main() == 0
    snap = json.loads((d / "snapshot-start.json").read_text())
    assert SCHEMA_KEYS <= set(snap.keys())
