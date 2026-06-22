"""Regression: extract_cards must not crash when a kanban-runs.json artifact exists.

gv2-2026-06-22-1 scoring crashed with NameError (json/Path used but not imported in
scripts/lib/gv2_metrics/cards.py). The bug only fires when run_root has
artifacts/kanban-runs.json — gv2-2026-06-21-7 had none, so it went unnoticed.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.lib.gv2_metrics.cards import extract_cards  # noqa: E402

BOARD = [
    {"id": "t_a", "title": "[SUPPLY] wood", "status": "done", "size": "M"},
    {"id": "t_b", "title": "[CONSTRUCT] shelter", "status": "todo"},
]


def test_extract_cards_no_run_root():
    out = extract_cards(BOARD)
    assert out["cards"][0]["outcome"] == "done"
    assert out["effectiveness_median"] == 80


def test_extract_cards_with_kanban_runs_artifact(tmp_path):
    # The path that crashed: run_root/artifacts/kanban-runs.json present.
    art = tmp_path / "artifacts"
    art.mkdir()
    (art / "kanban-runs.json").write_text(json.dumps({
        "cards": [{"id": "t_a", "task_runs": [{"started_at": 1000, "ended_at": 1700}]}]
    }))
    out = extract_cards(BOARD, run_root=tmp_path)
    rec = next(c for c in out["cards"] if c["id"] == "t_a")
    assert rec["wall_s"] == 700


def test_extract_cards_tolerates_bad_kanban_runs_json(tmp_path):
    art = tmp_path / "artifacts"
    art.mkdir()
    (art / "kanban-runs.json").write_text("{ not valid json")
    out = extract_cards(BOARD, run_root=tmp_path)  # must not raise
    assert len(out["cards"]) == 2
