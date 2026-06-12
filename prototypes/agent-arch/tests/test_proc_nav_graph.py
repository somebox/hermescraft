"""Proc-scout graph dry-run contracts."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "prototypes" / "agent-arch"))

from capstone.author import author_colony_lane  # noqa: E402
from capstone.graph_loader import load_graph  # noqa: E402
from capstone.wheat_graph import EPIC_BOT  # noqa: E402


def test_proc_scout_five_slugs():
    g = load_graph("proc-scout", repo_root=REPO_ROOT)
    assert len(g.cards) == 5
    slugs = [c.slug for c in g.cards]
    assert slugs == ["pn-plan", "pn-nav-1", "pn-nav-2", "pn-observe", "pn-plan-2"]


def test_planner_cards_cite_data_sources():
    g = load_graph("proc-scout", repo_root=REPO_ROOT)
    by_slug = {c.slug: c for c in g.cards}
    assert "last-scenario-map.json" in by_slug["pn-plan"].body
    assert "proc-nav-scout-runbook.md" in by_slug["pn-plan"].body
    assert "verify_results" in by_slug["pn-plan-2"].body


def test_execute_cards_have_bot_prefix():
    g = load_graph("proc-scout", repo_root=REPO_ROOT)
    inv = author_colony_lane(g, epic_bot=EPIC_BOT, board="proc-nav-lab")
    for inv in inv:
        if inv.slug.startswith("pn-nav") or inv.slug == "pn-observe":
            assert "[bot:mox]" in inv.cmd[-1].lower()


def test_run_proc_nav_dry_run_cli():
    proc = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "prototypes/agent-arch/capstone/run_proc_nav.py"),
            "--dry-run",
            "--board",
            "proc-nav-lab",
            "--graph",
            "proc-scout",
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert "pn-plan" in proc.stdout
