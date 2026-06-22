"""Tests for genesis-v2 mint model routing (config.yaml default: patch)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis2_lib as g2  # noqa: E402


def _patch_default_model(cfg_text: str, worker_model: str, planner_model: str, port: str) -> str:
    model = planner_model if not port else worker_model
    return re.sub(r"(\n\s*default:\s*)\S+", rf"\g<1>{model}", cfg_text, count=1)


def test_bodiless_gets_planner_model():
    yaml = "models:\n  default: old/model\n"
    out = _patch_default_model(yaml, "worker/x", "planner/y", "")
    assert "default: planner/y" in out


def test_worker_gets_worker_model():
    yaml = "models:\n  default: old/model\n"
    out = _patch_default_model(yaml, "worker/x", "planner/y", "3005")
    assert "default: worker/x" in out


def test_save_config_roundtrip_model_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(g2, "RUNS_ROOT", tmp_path / "runs")
    rid = "gv2-test-models"
    cfg = {
        "run_id": rid,
        "world": "genesis2",
        "seed": 1,
        "spawn": {"x": 0, "y": 64, "z": 0},
        "worker_model": "xiaomi/mimo-v2.5",
        "planner_model": "strong/planner",
        "started_at": "2026-06-21T00:00:00Z",
    }
    g2.save_config(cfg)
    loaded = g2.load_config(rid)
    assert loaded["worker_model"] == "xiaomi/mimo-v2.5"
    assert loaded["planner_model"] == "strong/planner"
