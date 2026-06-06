"""Pure SQL helpers for promotion logic.

These functions operate on an open `sqlite3.Connection` and never open
or close it themselves. The caller (gate-check or hook handler) owns
transaction lifecycle.

The schema we rely on is documented in
``~/.hermes/hermes-agent/hermes_cli/kanban_db.py`` (look for
``CREATE TABLE IF NOT EXISTS tasks``, ``task_links``, ``task_events``).
We use a stable subset; if the schema ever evolves, these helpers fail
loudly on missing columns rather than silently misbehaving.
"""

from __future__ import annotations

import json
import time
from typing import Optional

import sqlite3

from . import config
from .mutex_key import mutex_key


def is_chat_request(title: Optional[str]) -> bool:
    """Title-prefix match for the operator-interrupt exemption.

    Returns True iff the title starts with ``[CHAT_REQUEST]`` after
    stripping leading whitespace. None/empty titles return False.
    """
    if not title:
        return False
    return title.lstrip().startswith(config.CHAT_REQUEST_PREFIX)


def _undone_parents_exist(conn: sqlite3.Connection, task_id: str) -> bool:
    """True iff at least one parent of *task_id* is not yet done/archived."""
    row = conn.execute(
        """
        SELECT 1 FROM task_links l
        JOIN tasks p ON p.id = l.parent_id
        WHERE l.child_id = ?
          AND p.status NOT IN ('done', 'archived')
        LIMIT 1
        """,
        (task_id,),
    ).fetchone()
    return row is not None


def has_active_card(conn: sqlite3.Connection, key: str) -> bool:
    """True iff a card in mutex-domain *key* is actively occupying the
    queue (``ready`` or ``running``), excluding parked siblings + chat
    requests.

    *key* is the resolved mutex domain — see ``mutex_key.mutex_key``.
    For bot-tagged cards this is ``"bot:<name>"``; for untagged cards
    it's the assignee (lowercased). The function accepts a bare assignee
    string for backwards compatibility with pre-Concern-5 call sites
    that passed assignee directly — those callers still work, they just
    won't see bot-tagged cards' sharing/separation correctly. Caller-
    supplied keys are normalised to lowercase to preserve the prior
    case-insensitive contract.
    """
    key_lc = key.lower() if key else ""
    rows = conn.execute(
        """
        SELECT title, assignee, claim_lock FROM tasks
        WHERE status IN ('ready', 'running')
        """,
    ).fetchall()
    for r in rows:
        if is_chat_request(r["title"]):
            continue
        if mutex_key(r["assignee"], r["title"]) != key_lc:
            continue
        lock = r["claim_lock"] or ""
        if lock.startswith(config.MUTEX_LOCK_PREFIX):
            continue  # parked sibling — doesn't block promotion
        return True
    return False


def promote_next_for(conn: sqlite3.Connection, key: str) -> Optional[str]:
    """Promote the highest-priority eligible ``todo`` card in mutex-domain
    *key*.

    A card is eligible if all its parents are ``done``/``archived``.
    Within the eligible set, ordering is ``priority DESC, created_at ASC``.

    *key* is the resolved mutex domain (see ``mutex_key.mutex_key``). The
    function scans todos and filters by computed key, so a bot-tagged
    card promotes for its bot's queue even when other assignees share the
    profile name.

    Returns the promoted task_id, or None if the domain already has an
    active card or no eligible todo exists. Idempotent.
    """
    key_lc = key.lower() if key else ""
    if has_active_card(conn, key_lc):
        return None

    rows = conn.execute(
        """
        SELECT id, title, assignee, priority, created_at FROM tasks
        WHERE status = 'todo'
        ORDER BY priority DESC, created_at ASC
        """,
    ).fetchall()

    for row in rows:
        if mutex_key(row["assignee"], row["title"]) != key_lc:
            continue
        task_id = row["id"]
        if _undone_parents_exist(conn, task_id):
            continue
        # CAS-style update: only flip if still todo. Defends against a
        # racing dispatcher that promoted via recompute_ready between
        # SELECT and UPDATE.
        cur = conn.execute(
            "UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'todo'",
            (task_id,),
        )
        if cur.rowcount == 0:
            # Lost the race; let the caller retry on the next tick.
            continue
        _append_event(
            conn,
            task_id,
            "promoted",
            {"by": "landfolk-orchestrator", "reason": "assignee_free"},
        )
        return task_id

    return None


def park_via_lock(
    conn: sqlite3.Connection,
    task_id: str,
    key: str,
    reason: str,
    expires: int,
) -> bool:
    """Park a ``ready`` card by writing ``claim_lock=mutex_park:<key>``.

    *key* is the mutex domain (see ``mutex_key.mutex_key``). The lock
    string carries the resolved key directly, so two cards in the same
    domain serialize via lock-prefix matching, and gate-check's
    per-key sweep finds them via ``claim_lock LIKE 'mutex_park:%'``.

    The card stays in ``ready`` status (so it's visible in the queue
    and `recompute_ready` doesn't touch it) but the dispatcher's
    ``WHERE claim_lock IS NULL`` selector skips it. The next gate-check
    tick releases the lock when the domain's active card finishes.

    Returns True iff the row was updated (CAS-safe — no-op if the card
    isn't in ``ready`` any more or already locked by someone else).
    """
    marker = f"{config.MUTEX_LOCK_PREFIX}{key.lower()}"
    cur = conn.execute(
        """
        UPDATE tasks
        SET claim_lock = ?, claim_expires = ?
        WHERE id = ?
          AND status = 'ready'
          AND claim_lock IS NULL
        """,
        (marker, expires, task_id),
    )
    if cur.rowcount == 0:
        return False
    _append_event(
        conn,
        task_id,
        "mutex_parked",
        {"by": "landfolk-orchestrator", "reason": reason, "lock": marker},
    )
    return True


def release_mutex_lock(conn: sqlite3.Connection, task_id: str) -> bool:
    """Release a ``mutex_park:`` claim_lock so the card becomes dispatchable.

    Returns True iff a lock was released. CAS-safe — only clears locks
    with our mutex prefix, never touches other locks.
    """
    cur = conn.execute(
        """
        UPDATE tasks
        SET claim_lock = NULL, claim_expires = NULL
        WHERE id = ?
          AND claim_lock LIKE ?
        """,
        (task_id, f"{config.MUTEX_LOCK_PREFIX}%"),
    )
    if cur.rowcount == 0:
        return False
    _append_event(
        conn,
        task_id,
        "mutex_released",
        {"by": "landfolk-orchestrator"},
    )
    return True


def _append_event(
    conn: sqlite3.Connection,
    task_id: str,
    kind: str,
    payload: Optional[dict] = None,
) -> None:
    """Insert a row into ``task_events``.

    Schema (from kanban_db.py):
        task_events (id INTEGER PK, task_id TEXT, run_id INTEGER,
                     kind TEXT, payload TEXT, created_at INTEGER)
    We never set run_id — we're not associated with a worker run.
    """
    conn.execute(
        "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) "
        "VALUES (?, NULL, ?, ?, ?)",
        (
            task_id,
            kind,
            json.dumps(payload) if payload is not None else None,
            int(time.time()),
        ),
    )
