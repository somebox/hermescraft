"""Concern 4 contract — block → review → unblock → resume loop.

Pure kanban DB assertions. No MC, no LLM. Builds an isolated, temporary
kanban schema, drives a synthetic scenario through it, and asserts on
state transitions visible in the DB.

The scenario:
    1. Operator creates a 2-card chain: card A (parent), card B (child of A).
    2. Card A starts running, then blocks with reason
       `resource_not_found:iron_ore` (a structured prefix from
       board-dynamics.md § Blocked hygiene).
    3. Overseer pass runs.
       Assert: a [REVIEW] card exists whose `review_link` event payload
       carries `review_of=A_id`.
    4. Pytest fixture stubs the operator: comments + kanban_unblock A.
       Assert: A's status transitions back to a non-terminal state and
       gets a `unblocked` event.
    5. Card B's status reflects that A is no longer blocking it.

Idempotency:
    6. Run overseer pass a second time. Assert no NEW review card is created
       for A (the existing one is still "open" until done/archived).
    7. Archive A's review card; re-block A. Assert a NEW review fires.

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md (Session 3,
Concern 4).
Spec: prototypes/agent-arch/overseer/review_loop.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))  # for `overseer.review_loop`
from overseer.review_loop import find_pending_blocks, run_once  # noqa: E402


KANBAN_SCHEMA = """
CREATE TABLE tasks (
    id                   TEXT PRIMARY KEY,
    title                TEXT NOT NULL,
    body                 TEXT,
    assignee             TEXT,
    status               TEXT NOT NULL,
    priority             INTEGER DEFAULT 0,
    created_by           TEXT,
    created_at           INTEGER NOT NULL,
    started_at           INTEGER,
    completed_at         INTEGER,
    workspace_kind       TEXT NOT NULL DEFAULT 'scratch',
    tenant               TEXT,
    idempotency_key      TEXT
);
CREATE TABLE task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    run_id     INTEGER,
    kind       TEXT NOT NULL,
    payload    TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE task_links (
    parent_id  TEXT NOT NULL,
    child_id   TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
);
CREATE TABLE task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"""

TENANT = "proto-overseer-test"


# ────────────────────────────────────────────────────────────────────
# Fixtures
# ────────────────────────────────────────────────────────────────────


@pytest.fixture
def db(tmp_path: Path) -> Path:
    """A temp kanban.db with the proto schema applied."""
    p = tmp_path / "kanban.db"
    conn = sqlite3.connect(str(p))
    try:
        conn.executescript(KANBAN_SCHEMA)
        conn.commit()
    finally:
        conn.close()
    return p


def _create_card(
    conn: sqlite3.Connection,
    *,
    id: str,
    title: str,
    assignee: str,
    body: str = "",
    status: str = "todo",
    tenant: str = TENANT,
) -> None:
    now = int(time.time())
    conn.execute(
        """
        INSERT INTO tasks (id, title, body, assignee, status, created_by, created_at, tenant)
        VALUES (?, ?, ?, ?, ?, 'test-operator', ?, ?)
        """,
        (id, title, body, assignee, status, now, tenant),
    )
    conn.execute(
        "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, 'created', NULL, ?)",
        (id, now),
    )
    conn.commit()


def _set_status(conn: sqlite3.Connection, card_id: str, status: str) -> None:
    conn.execute("UPDATE tasks SET status = ? WHERE id = ?", (status, card_id))
    conn.commit()


def _block(conn: sqlite3.Connection, card_id: str, reason: str) -> None:
    _set_status(conn, card_id, "blocked")
    now = int(time.time())
    conn.execute(
        "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, 'blocked', ?, ?)",
        (card_id, json.dumps({"reason": reason}), now),
    )
    conn.commit()


def _operator_unblock(conn: sqlite3.Connection, card_id: str, comment: str) -> None:
    """Pytest fixture's stand-in for operator → kanban_comment + kanban_unblock."""
    now = int(time.time())
    conn.execute(
        "INSERT INTO task_comments (task_id, author, body, created_at) VALUES (?, 'operator', ?, ?)",
        (card_id, comment, now),
    )
    conn.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (card_id,))
    conn.execute(
        "INSERT INTO task_events (task_id, kind, payload, created_at) VALUES (?, 'unblocked', NULL, ?)",
        (card_id, now),
    )
    conn.commit()


def _link_parent_child(conn: sqlite3.Connection, parent: str, child: str) -> None:
    conn.execute(
        "INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)",
        (parent, child),
    )
    conn.commit()


def _chain_two_cards(conn: sqlite3.Connection) -> tuple[str, str]:
    """Create card A (running) → card B (todo, depends on A)."""
    _create_card(conn, id="t_A", title="navigate to :mine_nw:", assignee="pilot-navigator", status="running")
    _create_card(conn, id="t_B", title="extract 4 iron at :mine_nw:", assignee="pilot-miner", status="todo")
    _link_parent_child(conn, "t_A", "t_B")
    return "t_A", "t_B"


# ────────────────────────────────────────────────────────────────────
# Tests
# ────────────────────────────────────────────────────────────────────


def test_block_with_recognized_prefix_files_review_card(db: Path) -> None:
    """The core loop: block → run overseer → [REVIEW] card exists."""
    conn = sqlite3.connect(str(db))
    try:
        a, b = _chain_two_cards(conn)
        _block(conn, a, "resource_not_found:iron_ore")
    finally:
        conn.close()

    created = run_once(db, tenant=TENANT)
    assert len(created) == 1, f"expected 1 review card, got {created}"
    review_id = created[0]

    # The review card itself is a [REVIEW] todo with `metadata.review_of` linkage
    conn = sqlite3.connect(str(db))
    try:
        title, status, assignee, body = conn.execute(
            "SELECT title, status, assignee, body FROM tasks WHERE id = ?",
            (review_id,),
        ).fetchone()
        assert title.startswith("[REVIEW]")
        assert "resource_not_found" in title
        assert a in title
        assert status == "todo"
        assert assignee == "overseer"
        assert a in body, "review body should reference the blocked card id"

        # Linkage via review_link event
        ev = conn.execute(
            """
            SELECT payload FROM task_events
            WHERE task_id = ? AND kind = 'review_link'
            """,
            (review_id,),
        ).fetchone()
        assert ev is not None
        payload = json.loads(ev[0])
        assert payload["review_of"] == a
        assert payload["prefix"] == "resource_not_found"
        assert payload["rest"] == "iron_ore"
        assert payload["unrecognized_prefix"] is False
    finally:
        conn.close()


def test_unrecognized_prefix_still_fires_with_flag(db: Path) -> None:
    """A block reason that doesn't match a known prefix still gets a review,
    but with `unrecognized_prefix=True` so the operator can decide whether
    to extend the recognized set."""
    conn = sqlite3.connect(str(db))
    try:
        _create_card(conn, id="t_X", title="some card", assignee="pilot-navigator", status="running")
        _block(conn, "t_X", "weird_situation:something_unexpected")
    finally:
        conn.close()

    created = run_once(db, tenant=TENANT)
    assert len(created) == 1

    conn = sqlite3.connect(str(db))
    try:
        ev = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'review_link'",
            (created[0],),
        ).fetchone()
        payload = json.loads(ev[0])
        assert payload["prefix"] == ""
        assert payload["unrecognized_prefix"] is True
        title = conn.execute(
            "SELECT title FROM tasks WHERE id = ?", (created[0],)
        ).fetchone()[0]
        assert "unknown_reason" in title
    finally:
        conn.close()


def test_idempotent_no_duplicate_review_on_rerun(db: Path) -> None:
    """Running the overseer twice on the same blocked state yields exactly
    one review card."""
    conn = sqlite3.connect(str(db))
    try:
        a, _ = _chain_two_cards(conn)
        _block(conn, a, "tool_required:iron_pickaxe")
    finally:
        conn.close()

    first = run_once(db, tenant=TENANT)
    second = run_once(db, tenant=TENANT)
    assert len(first) == 1
    assert len(second) == 0, "second pass should not duplicate the review"


def test_unblock_lets_card_resume_chain_intact(db: Path) -> None:
    """Operator unblocks the card; the chain link to B survives untouched."""
    conn = sqlite3.connect(str(db))
    try:
        a, b = _chain_two_cards(conn)
        _block(conn, a, "tool_required:iron_pickaxe")
    finally:
        conn.close()

    run_once(db, tenant=TENANT)

    # Operator-comment stand-in: comment + unblock
    conn = sqlite3.connect(str(db))
    try:
        _operator_unblock(conn, a, "Gave the worker an iron pickaxe; retry.")
    finally:
        conn.close()

    # Assert: A is ready, has an `unblocked` event, has the comment.
    # B's parent link to A is unchanged.
    conn = sqlite3.connect(str(db))
    try:
        a_status = conn.execute("SELECT status FROM tasks WHERE id = ?", (a,)).fetchone()[0]
        assert a_status == "ready"

        unblock_count = conn.execute(
            "SELECT COUNT(*) FROM task_events WHERE task_id = ? AND kind = 'unblocked'",
            (a,),
        ).fetchone()[0]
        assert unblock_count == 1

        comment_count = conn.execute(
            "SELECT COUNT(*) FROM task_comments WHERE task_id = ? AND author = 'operator'",
            (a,),
        ).fetchone()[0]
        assert comment_count == 1

        link_count = conn.execute(
            "SELECT COUNT(*) FROM task_links WHERE parent_id = ? AND child_id = ?",
            (a, b),
        ).fetchone()[0]
        assert link_count == 1, "parent_id → child_id link must survive unblock"
    finally:
        conn.close()


def test_reblock_after_archived_review_fires_new_review(db: Path) -> None:
    """Closing the loop: if a card is unblocked, then re-blocked, and the
    previous review is done/archived, a fresh review fires for the new
    block event."""
    conn = sqlite3.connect(str(db))
    try:
        a, _ = _chain_two_cards(conn)
        _block(conn, a, "tool_required:iron_pickaxe")
    finally:
        conn.close()

    first_reviews = run_once(db, tenant=TENANT)
    assert len(first_reviews) == 1
    first_review_id = first_reviews[0]

    # Operator resolves the first review; A unblocks; later A re-blocks
    conn = sqlite3.connect(str(db))
    try:
        _set_status(conn, first_review_id, "done")
        _operator_unblock(conn, a, "Gave the pickaxe.")
        _set_status(conn, a, "running")
        _block(conn, a, "resource_not_found:iron_ore")
    finally:
        conn.close()

    second_reviews = run_once(db, tenant=TENANT)
    assert len(second_reviews) == 1, (
        "second block after first review was closed should fire a new review"
    )
    assert second_reviews[0] != first_review_id


def test_tenant_isolation(db: Path) -> None:
    """Overseer scoped to one tenant doesn't see blocks on other tenants."""
    conn = sqlite3.connect(str(db))
    try:
        _create_card(conn, id="t_mine", title="mine card", assignee="x", status="running", tenant=TENANT)
        _create_card(conn, id="t_other", title="other tenant card", assignee="y", status="running", tenant="some-other-tenant")
        _block(conn, "t_mine", "resource_not_found:iron_ore")
        _block(conn, "t_other", "resource_not_found:iron_ore")
    finally:
        conn.close()

    mine = run_once(db, tenant=TENANT)
    assert len(mine) == 1

    # Confirm the other tenant's block is still pending an overseer of its own
    others = run_once(db, tenant="some-other-tenant")
    assert len(others) == 1


def test_find_pending_blocks_returns_structured_signal(db: Path) -> None:
    """Direct unit on the parser — useful for diagnosing nested issues."""
    conn = sqlite3.connect(str(db))
    try:
        _create_card(conn, id="t_n", title="navigator card", assignee="pilot-navigator", status="running")
        _block(conn, "t_n", "nav_needs_miner:dig_4_cells")
    finally:
        conn.close()

    conn = sqlite3.connect(str(db))
    try:
        signals = find_pending_blocks(conn, tenant=TENANT)
    finally:
        conn.close()
    assert len(signals) == 1
    s = signals[0]
    assert s.task_id == "t_n"
    assert s.reason == "nav_needs_miner:dig_4_cells"
    assert s.prefix == "nav_needs_miner"
    assert s.rest == "dig_4_cells"
