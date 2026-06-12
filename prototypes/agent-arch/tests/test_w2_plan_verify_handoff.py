"""pv002 verify_results handoff contract (live run optional)."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
REPO_ROOT = Path(__file__).resolve().parents[3]
POSTMORTEMS_DIR = REPO_ROOT / "data" / "postmortems" / "wheat-capstone"


@pytest.fixture(scope="module")
def run_id() -> str:
    env = os.environ.get("W2_PLAN_VERIFY_RUN_ID")
    if not env:
        pytest.skip("set W2_PLAN_VERIFY_RUN_ID after plan-verify trial")
    return env


def test_pv002_verify_results(run_id: str):
    manifest = json.loads((POSTMORTEMS_DIR / run_id / "manifest.json").read_text())
    slug_to_id = {c["slug"]: c["card_id"] for c in manifest["cards"]}
    pv002 = slug_to_id.get("pv002")
    assert pv002, "pv002 missing from manifest"
    board = manifest.get("board", "wheat-capstone")
    db = HERMES_HOME / "kanban" / "boards" / board / "kanban.db"
    conn = sqlite3.connect(str(db))
    row = conn.execute(
        "SELECT metadata FROM task_runs WHERE task_id=? AND outcome='completed' ORDER BY started_at DESC LIMIT 1",
        (pv002,),
    ).fetchone()
    conn.close()
    assert row, "no completed run for pv002"
    meta = json.loads(row[0] or "{}")
    vr = meta.get("verify_results") or meta
    assert vr.get("observation_source") == "live_worker" or "predicates" in vr
