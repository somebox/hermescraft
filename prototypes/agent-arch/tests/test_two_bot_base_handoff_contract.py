"""Handoff contract test for the two-bot demo.

Mirrors test_handoff_contract.py's pattern, scoped to ONE handoff edge
for v1: ``p_nav_wood`` → ``p_withdraw_wood``. The architectural
question is the same — does the parent's ``exit_pos`` actually reach
the child worker's spawn context? — but the parameterisation here
is by run_id (from the manifest), not by scenario.

What we prove:
  1. ``p_nav_wood`` (navigator) emitted ``exit_pos`` in its
     task_runs.metadata.
  2. ``p_withdraw_wood`` (crafter, depends on p_nav_wood) was spawned
     with the parent's exit_pos value literally present in its worker
     session's message corpus.

Skipped (with reason) when no manifest exists yet — supports the
"run --create-only first" flow and the case where the run hasn't
completed enough for handoff data to exist.

Pinned to v1: ONE edge. Once this passes, future sessions extend to
the full matrix (every edge in the DAG).

Usage:

    HERMES_HOME=$HOME/.hermes-proto-agent-arch \\
      pytest prototypes/agent-arch/tests/test_two_bot_base_handoff_contract.py \\
        --run-id <id>

Or set TWO_BOT_RUN_ID in the env. If neither is given, picks the most
recent run_id under data/postmortems/two-bot-base/.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

import pytest

HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes-proto-agent-arch"))


def _kanban_db_for_run(manifest: dict) -> Path:
    """Locate the kanban DB used by this run.

    Manifest carries `board` (set by run_two_bot_base.py via --board).
    Two layouts:
      - flat (proto rig, board=None): HERMES_HOME/kanban.db
      - boards-per-tenant (live --board <name>): HERMES_HOME/kanban/
        boards/<name>/kanban.db
    """
    board = manifest.get("board")
    if board:
        path = HERMES_HOME / "kanban" / "boards" / board / "kanban.db"
        if path.exists():
            return path
    return HERMES_HOME / "kanban.db"

REPO_ROOT = Path(__file__).resolve().parents[3]
POSTMORTEMS_DIR = REPO_ROOT / "data" / "postmortems" / "two-bot-base"

PARENT_SLUG = "p_nav_wood"
CHILD_SLUG = "p_withdraw_wood"
CHILD_PROFILE = "pilot-pip"


# ── Run-id discovery ──────────────────────────────────────────────

def _pytest_addoption(parser):  # pytest hook — recognised by name
    parser.addoption("--run-id", action="store", default=None,
                     help="trial run_id to assert against")


def pytest_addoption(parser):
    _pytest_addoption(parser)


def _resolve_run_id(request) -> str:
    cli = request.config.getoption("--run-id", default=None)
    env = os.environ.get("TWO_BOT_RUN_ID")
    if cli:
        return cli
    if env:
        return env
    # Most-recent fallback.
    if not POSTMORTEMS_DIR.exists():
        pytest.skip(f"no postmortem dir at {POSTMORTEMS_DIR}; run --create-only first")
    runs = sorted(POSTMORTEMS_DIR.glob("*/manifest.json"),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    if not runs:
        pytest.skip(f"no manifests in {POSTMORTEMS_DIR}; run --create-only first")
    return runs[0].parent.name


@pytest.fixture(scope="module")
def manifest(request) -> dict:
    run_id = _resolve_run_id(request)
    path = POSTMORTEMS_DIR / run_id / "manifest.json"
    if not path.exists():
        pytest.skip(f"no manifest for run_id={run_id} at {path}")
    return json.loads(path.read_text())


@pytest.fixture(scope="module")
def card_ids(manifest) -> dict[str, str]:
    return {c["slug"]: c["card_id"] for c in manifest["cards"]}


@pytest.fixture(scope="module")
def kanban_db(manifest) -> Path:
    """Per-manifest kanban DB lookup — board-aware."""
    return _kanban_db_for_run(manifest)


# ── DB helpers (mirror test_handoff_contract.py) ──────────────────

def _connect(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        pytest.skip(f"DB not found: {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _completed_run_metadata(kanban_db: Path, task_id: str) -> dict:
    conn = _connect(kanban_db)
    row = conn.execute(
        """
        SELECT metadata, outcome
        FROM task_runs
        WHERE task_id = ? AND outcome = 'completed'
        ORDER BY started_at DESC
        LIMIT 1
        """,
        (task_id,),
    ).fetchone()
    conn.close()
    if not row:
        pytest.skip(f"no completed run for task {task_id} (yet?)")
    return json.loads(row["metadata"]) if row["metadata"] else {}


def _worker_session_id(kanban_db: Path, task_id: str) -> str:
    md = _completed_run_metadata(kanban_db, task_id)
    sid = md.get("worker_session_id")
    if not sid:
        pytest.fail(f"no worker_session_id in run metadata for {task_id}")
    return sid


def _message_corpus(profile: str, session_id: str) -> str:
    db = HERMES_HOME / "profiles" / profile / "state.db"
    conn = _connect(db)
    rows = conn.execute(
        """
        SELECT role, content, tool_name, tool_calls, reasoning
        FROM messages
        WHERE session_id = ?
        ORDER BY id
        """,
        (session_id,),
    ).fetchall()
    conn.close()
    parts: list[str] = []
    for row in rows:
        parts.append(f"\n[role={row['role']}]")
        for col in ("content", "tool_calls", "tool_name", "reasoning"):
            if row[col]:
                parts.append(row[col])
    return "\n".join(parts)


# ── Assertions ─────────────────────────────────────────────────────

def test_parent_emits_exit_pos(card_ids, kanban_db):
    """p_nav_wood (navigator) must emit exit_pos in its completion
    metadata — that's the data the child reads."""
    parent_id = card_ids[PARENT_SLUG]
    md = _completed_run_metadata(kanban_db, parent_id)
    assert "exit_pos" in md, (
        f"{PARENT_SLUG} card {parent_id} missing exit_pos in metadata; "
        f"got keys: {sorted(md.keys())}"
    )
    exit_pos = md["exit_pos"]
    assert isinstance(exit_pos, list) and len(exit_pos) == 3, (
        f"exit_pos should be [x, y, z]; got {exit_pos!r}"
    )
    print(f"[ok] parent={parent_id} exit_pos={exit_pos}")


def test_child_received_parent_exit_pos(card_ids, kanban_db):
    """p_withdraw_wood's worker session must contain p_nav_wood's
    exit_pos value as a substring. This is the load-bearing check that
    handoff metadata actually crosses the spawn boundary — skill text
    saying 'read parent metadata' isn't enforcement."""
    parent_id = card_ids[PARENT_SLUG]
    child_id = card_ids[CHILD_SLUG]
    parent_md = _completed_run_metadata(kanban_db, parent_id)
    expected = parent_md["exit_pos"]

    child_session = _worker_session_id(kanban_db, child_id)
    corpus = _message_corpus(CHILD_PROFILE, child_session)

    # Same dual-form check as test_handoff_contract.py — JSON-pretty
    # AND compact comma-separated. One form usually wins per Hermes
    # version's kanban_show serialization.
    json_form = json.dumps(expected, separators=(", ", ": "))
    compact = ",".join(str(v) for v in expected)
    found_json = json_form in corpus
    found_compact = compact in corpus

    assert found_json or found_compact, (
        f"child {CHILD_SLUG} ({child_id}) session {child_session} did NOT "
        f"contain parent {PARENT_SLUG}'s exit_pos {expected}. Either "
        f"kanban_show context didn't include parent metadata, or the "
        f"skill never read it."
    )
    print(f"[ok] child {CHILD_SLUG} saw parent exit_pos={expected} "
          f"(json={found_json}, compact={found_compact})")
