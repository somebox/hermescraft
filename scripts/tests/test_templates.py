"""Genesis template validation and render."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis_lib as gl  # noqa: E402


def test_validate_templates_ok():
    gl.validate_templates()


def test_render_substitutes_scalars(tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "RUNS_ROOT", tmp_path / "genesis-runs")
    monkeypatch.setattr(gl, "DATA_DIR", tmp_path / "data")
    (tmp_path / "data" / "ops" / "plans").mkdir(parents=True)
    src_plan = REPO / "data" / "ops" / "plans" / "hut1-guard-tower-plan.json"
    if src_plan.exists():
        import shutil

        shutil.copy(src_plan, tmp_path / "data" / "ops" / "plans" / "hut1-guard-tower-plan.json")
    else:
        (tmp_path / "data" / "ops" / "plans" / "hut1-guard-tower-plan.json").write_text(
            json.dumps({"anchor": {"coords": [0, 65, 0], "marker": {"coords": [0, 65, 0]}}})
        )
    rid = "g-2099-01-01-1"
    anchor = {"x": 10, "y": 64, "z": -20}
    cfg = gl.render_templates(run_id=rid, seed=42, anchor=anchor, difficulty=None)
    assert cfg["base_anchor"] == anchor
    assert cfg["system_chest_at"]["x"] == anchor["x"] + 1
    regions = json.loads((tmp_path / "data" / "regions-world.json").read_text())
    assert regions["regions"][0]["anchor"]["x"] == 10
