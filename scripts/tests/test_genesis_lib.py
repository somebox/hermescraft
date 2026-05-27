"""Genesis lib unit tests (no homelab ssh)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis_lib as gl  # noqa: E402


def test_next_run_id_format():
    rid = gl.next_run_id()
    assert rid.startswith("g-")
    parts = rid.split("-")
    assert len(parts) >= 5


def test_parse_anchor():
    assert gl.parse_anchor("0,64,0") == {"x": 0, "y": 64, "z": 0}


def test_build_context_flat_placeholders():
    ctx = gl.build_context(run_id="g-2026-01-01-1", seed=1, anchor={"x": 0, "y": 64, "z": 0})
    assert "anchor_x" in ctx and ctx["anchor_x"] == "0"
    assert "system_chest_x" in ctx


def test_substitute_unknown_placeholder():
    with pytest.raises(KeyError):
        gl.substitute("{unknown_x}", {"anchor_x": "1"})


@patch("genesis_lib._kanban_create")
def test_seed_starter_cards_topology(mock_create, tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "RUNS_ROOT", tmp_path / "runs")
    calls = []

    def fake(**kw):
        tid = str(len(calls) + 1)
        calls.append(kw)
        return tid

    mock_create.side_effect = fake
    ctx = gl.build_context(run_id="g-2026-01-01-1", seed=1, anchor={"x": 0, "y": 64, "z": 0})
    meta = gl.seed_starter_cards("g-2026-01-01-1", ctx)
    assert len(meta["epic_ids"]) == 4
    assert len(meta["p1_card_ids"]) == 5
    # epics chain parents
    assert calls[0]["parent_id"] is None
    assert calls[1]["parent_id"] == "1"
    assert calls[2]["parent_id"] == "2"
    assert calls[3]["parent_id"] == "3"
    # p1 cards no parent
    for c in calls[4:]:
        assert c["parent_id"] is None


def test_check_phases_empty_state(tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "DATA_DIR", tmp_path / "data")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "regions-world.json").write_text('{"regions": []}')
    cfg = {
        "run_id": "g-x",
        "seed": 1,
        "base_anchor": {"x": 0, "y": 64, "z": 0},
    }
    with patch("genesis_lib._kanban_list", return_value=[]):
        with patch("genesis_lib._run") as mock_run:
            mock_run.return_value = type("R", (), {"returncode": 0, "stdout": "{}"})()
            r = gl.check_phases(cfg)
    assert "P1" in r
    assert r["P1"]["pass"] is False
