"""proc-nav-mvtp-bots command builder."""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_path = ROOT / "scripts" / "proc-nav-mvtp-bots.py"
_spec = importlib.util.spec_from_file_location("proc_nav_mvtp_bots", _path)
assert _spec and _spec.loader
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
build_commands = _mod.build_commands


def test_build_mvtp_and_tp():
    cmds = build_commands(
        world="proc-nav",
        players=["Mox", "Pip"],
        tp_xyz=(-19, 90, 28),
    )
    assert cmds == [
        "mvtp Mox proc-nav",
        "execute in proc-nav run tp Mox -19 90 28",
        "mvtp Pip proc-nav",
        "execute in proc-nav run tp Pip -19 90 28",
    ]
