"""Render {{BOT_USERNAME}} and {{PROC_WORLD}} in agent-test-from-map."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "agent_test_from_map",
    ROOT / "scripts" / "agent-test-from-map.py",
)
atm = importlib.util.module_from_spec(_spec)
assert _spec.loader
_spec.loader.exec_module(atm)


def test_render_bot_username_and_proc_world():
    os.environ["MC_USERNAME"] = "Mox"
    os.environ["PROC_WORLD"] = "proc-nav"
    template = "world: {{PROC_WORLD}}\nmvtp {{BOT_USERNAME}} {{PROC_WORLD}}\n"
    card = {"placements": {"spawn": [1, 64, 2]}}
    out = atm.render_spec(template, card)
    assert "proc-nav" in out
    assert "Mox" in out
    assert "{{" not in out
