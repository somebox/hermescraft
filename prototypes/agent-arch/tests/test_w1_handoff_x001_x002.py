"""W1 handoff contract: x001 (navigator) → x002 (builder).

Reads parent metadata from ``task_runs.metadata`` (completed outcome).
Tolerant: non-empty ``exit_pos`` OR non-empty ``work_at_mark``.

Usage:
  W1_RUN_ID=<run-id> HERMES_HOME=~/.hermes \\
    pytest prototypes/agent-arch/tests/test_w1_handoff_x001_x002.py -q
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import pytest

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
REPO_ROOT = Path(__file__).resolve().parents[3]
POSTMORTEMS_DIR = REPO_ROOT / "data" / "postmortems" / "wheat-capstone"

PARENT_SLUG = "x001"
CHILD_SLUG = "x002"
W1_ROLES = frozenset({"navigator", "builder", "farmer", "crafter"})


def _kanban_db_for_run(manifest: dict) -> Path:
    board = manifest.get("board")
    if board:
        path = HERMES_HOME / "kanban" / "boards" / board / "kanban.db"
        if path.exists():
            return path
    return HERMES_HOME / "kanban.db"


def _resolve_run_id(request) -> str:
    cli = request.config.getoption("--run-id", default=None)
    if cli:
        return cli
    env = os.environ.get("W1_RUN_ID")
    if env:
        return env
    runs = sorted(
        POSTMORTEMS_DIR.glob("*/manifest.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not runs:
        pytest.skip("no W1 run id — set W1_RUN_ID or pass --run-id after a live trial")
    run_id = runs[0].parent.name
    manifest_path = POSTMORTEMS_DIR / run_id / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    assignees = {c.get("assignee") for c in manifest.get("cards", [])}
    if not assignees <= W1_ROLES:
        pytest.skip(
            f"latest run {run_id} is not W1 (assignees={assignees}); "
            "set W1_RUN_ID to a role-agent trial"
        )
    return run_id


@pytest.fixture(scope="module")
def run_id(request) -> str:
    return _resolve_run_id(request)


@pytest.fixture(scope="module")
def manifest(run_id: str) -> dict:
    path = POSTMORTEMS_DIR / run_id / "manifest.json"
    if not path.exists():
        pytest.skip(f"no manifest at {path}")
    return json.loads(path.read_text())


@pytest.fixture(scope="module")
def card_ids(manifest) -> dict[str, str]:
    return {c["slug"]: c["card_id"] for c in manifest["cards"]}


@pytest.fixture(scope="module")
def kanban_db(manifest) -> Path:
    db = _kanban_db_for_run(manifest)
    if not db.exists():
        pytest.skip(f"kanban db not found: {db}")
    return db


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _completed_run_metadata(kanban_db: Path, task_id: str) -> dict:
    conn = _connect(kanban_db)
    row = conn.execute(
        """
        SELECT metadata FROM task_runs
        WHERE task_id = ? AND outcome = 'completed'
        ORDER BY started_at DESC LIMIT 1
        """,
        (task_id,),
    ).fetchone()
    conn.close()
    if not row or not row["metadata"]:
        pytest.skip(f"no completed run metadata for {task_id} yet")
    return json.loads(row["metadata"])


def _message_corpus(profile: str, session_id: str) -> str:
    db = HERMES_HOME / "profiles" / profile / "state.db"
    if not db.exists():
        pytest.skip(f"no state.db for profile {profile}")
    conn = _connect(db)
    rows = conn.execute(
        """
        SELECT content, tool_calls, reasoning FROM messages
        WHERE session_id = ? ORDER BY id
        """,
        (session_id,),
    ).fetchall()
    conn.close()
    parts = []
    for row in rows:
        for col in ("content", "tool_calls", "reasoning"):
            if row[col]:
                parts.append(row[col])
    return "\n".join(parts)


def test_parent_handoff_metadata_present(card_ids, kanban_db):
    parent_id = card_ids[PARENT_SLUG]
    md = _completed_run_metadata(kanban_db, parent_id)
    has_exit = bool(md.get("exit_pos"))
    has_mark = bool(md.get("work_at_mark"))
    assert has_exit or has_mark, (
        f"{PARENT_SLUG} needs exit_pos or work_at_mark; keys={sorted(md.keys())}"
    )


def test_child_saw_parent_handoff(card_ids, kanban_db, manifest):
    parent_id = card_ids[PARENT_SLUG]
    child_id = card_ids[CHILD_SLUG]
    parent_md = _completed_run_metadata(kanban_db, parent_id)
    child_md = _completed_run_metadata(kanban_db, child_id)
    child_sid = child_md.get("worker_session_id")
    if not child_sid:
        pytest.fail(f"{CHILD_SLUG} missing worker_session_id in run metadata")

    child_role = next(
        c["assignee"] for c in manifest["cards"] if c["slug"] == CHILD_SLUG
    )
    corpus = _message_corpus(child_role, child_sid)

    needles: list[str] = []
    if parent_md.get("exit_pos"):
        ep = parent_md["exit_pos"]
        if isinstance(ep, list):
            needles.append(json.dumps(ep, separators=(", ", ": ")))
            needles.append(",".join(str(v) for v in ep))
    if parent_md.get("work_at_mark"):
        needles.append(str(parent_md["work_at_mark"]))

    assert any(n and n in corpus for n in needles), (
        f"child {CHILD_SLUG} session did not contain parent handoff fields"
    )
