"""Unit tests for scripts/agent-test-from-map.py rendering."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_atm():
    path = ROOT / "scripts/agent-test-from-map.py"
    spec = importlib.util.spec_from_file_location("agent_test_from_map", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["agent_test_from_map"] = mod
    spec.loader.exec_module(mod)
    return mod


atm = _load_atm()


def test_render_spec_replaces_anchors():
    card = {
        "seed": "4242",
        "placements": {"spawn": [10, 64, -5], "muster": [16, 64, -5]},
    }
    template = "tp {{SPAWN_X}} {{SPAWN_Y}} {{SPAWN_Z}} goto {{MUSTER_X}} {{MUSTER_Y}} {{MUSTER_Z}}"
    out = atm.render_spec(template, card)
    assert out == "tp 10 64 -5 goto 16 64 -5"


def test_substitution_map_build_pad_watch_post():
    card = {
        "placements": {
            "spawn": [1, 2, 3],
            "build_pad": [10, 20, 30],
            "watch_post": [14, 20, 34],
        }
    }
    template = "pad {{BUILD_PAD_X}} post {{WATCH_POST_Z}}"
    m = atm.substitution_map(card, template)
    assert m["{{BUILD_PAD_X}}"] == "10"
    assert m["{{WATCH_POST_Z}}"] == "34"


def test_render_spec_ignores_comment_like_braces():
    card = {"placements": {"spawn": [1, 2, 3], "muster": [4, 5, 6]}}
    template = "# docs mention {{SPAWN_*}} placeholders\nx: {{MUSTER_X}}\n"
    out = atm.render_spec(template, card)
    assert out.endswith("x: 4\n")
    assert "{{MUSTER_X}}" not in out
