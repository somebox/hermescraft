"""pn-observe verify_results handoff contract (live run optional)."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
REPO_ROOT = Path(__file__).resolve().parents[3]
POSTMORTEMS_DIR = REPO_ROOT / "data" / "postmortems" / "proc-nav-lab"


@pytest.fixture(scope="module")
def run_id() -> str:
    env = os.environ.get("PROC_NAV_RUN_ID")
    if not env:
        pytest.skip("set PROC_NAV_RUN_ID after proc-scout trial")
    return env


def test_pn_observe_verify_results(run_id: str):
    manifest = json.loads((POSTMORTEMS_DIR / run_id / "manifest.json").read_text())
    slug_to_id = {c["slug"]: c["card_id"] for c in manifest["cards"]}
    observe = slug_to_id.get("pn-observe")
    assert observe, "pn-observe missing from manifest"
    board = manifest.get("board", "proc-nav-lab")
    db = HERMES_HOME / "kanban" / "boards" / board / "kanban.db"
    if not db.is_file():
        pytest.skip(f"no kanban db at {db}")
    conn = sqlite3.connect(str(db))
    row = conn.execute(
        "SELECT metadata FROM task_runs WHERE task_id=? AND outcome='completed' "
        "ORDER BY started_at DESC LIMIT 1",
        (observe,),
    ).fetchone()
    conn.close()
    assert row, "no completed run for pn-observe"
    meta = json.loads(row[0] or "{}")
    vr = meta.get("verify_results") or meta
    assert vr.get("observation_source") == "live_worker" or "predicates" in vr
