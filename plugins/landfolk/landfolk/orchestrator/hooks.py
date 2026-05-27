"""``post_tool_call`` observer handlers.

The hook policy is **observer-only**: we never block tool calls. Tools
always succeed; we do reactive housekeeping via side-effect SQL writes
to keep the per-assignee invariant. The gate-check tick (≤60s) is the
enforcement layer; hooks just bring the common case under the cap
within milliseconds instead of seconds.

Five tool names are interesting:

  * ``kanban_complete`` / ``kanban_block`` — assignee just freed up;
    promote the next-best ``todo`` for that assignee.
  * ``kanban_create`` / ``kanban_unblock`` — if the just-touched card
    landed in ``ready`` and the assignee already had a running/ready
    sibling, demote it back to ``todo``.
  * ``kanban_archive`` — find children that were waiting on this
    parent; comment a warning that their dependency is gone.

All handlers swallow exceptions (we log to the dispatcher log; we
never crash the agent loop).
"""

from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any, Optional

from . import config
from .promote import (
    _append_event,
    has_active_card,
    is_chat_request,
    park_via_lock,
    promote_next_for,
    release_mutex_lock,
)

logger = logging.getLogger(__name__)


# Tool names we react to. Importing lazily inside the handler keeps the
# plugin load cheap.
_PROMOTE_TRIGGERS = {"kanban_complete", "kanban_block"}
_DEMOTE_TRIGGERS = {"kanban_create", "kanban_unblock"}
_ARCHIVE_TRIGGERS = {"kanban_archive"}


def _connect_board() -> Optional[sqlite3.Connection]:
    """Open a fresh connection on the configured board.

    Returns None on failure — handlers treat that as "skip this tick".
    """
    try:
        from hermes_cli.kanban_db import connect  # local import — avoid hard dep at module-load
        return connect(board=config.BOARD)
    except Exception:  # noqa: BLE001
        logger.exception("landfolk-orch: failed to open kanban db for board=%s", config.BOARD)
        return None


def _resolve_task_id(args: Optional[dict], result: Any) -> Optional[str]:
    """Best-effort task_id extraction from a kanban_* tool call.

    Order of preference:
      1. ``args['task_id']`` — most kanban tools take this directly.
      2. ``args['id']`` — alternate argname some tools use.
      3. ``result['task_id']`` — kanban_create returns this.
      4. ``result['data']['task_id']`` — nested envelope variant.
    """
    if isinstance(args, dict):
        for key in ("task_id", "id"):
            v = args.get(key)
            if isinstance(v, str) and v:
                return v
    if isinstance(result, dict):
        v = result.get("task_id")
        if isinstance(v, str) and v:
            return v
        data = result.get("data")
        if isinstance(data, dict):
            v = data.get("task_id")
            if isinstance(v, str) and v:
                return v
    return None


def _get_assignee_and_status(conn: sqlite3.Connection, task_id: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    row = conn.execute(
        "SELECT lower(coalesce(assignee, '')) AS a, status, title FROM tasks WHERE id = ?",
        (task_id,),
    ).fetchone()
    if row is None:
        return None, None, None
    return (row["a"] or None), row["status"], row["title"]


def on_post_tool_call(
    tool_name: str = "",
    args: Optional[dict] = None,
    result: Any = None,
    task_id: str = "",
    session_id: str = "",
    tool_call_id: str = "",
    duration_ms: int = 0,
    **_: Any,
) -> None:
    """Dispatch to the appropriate handler based on tool_name."""
    if config.DISABLE_HOOKS:
        return
    if tool_name not in (_PROMOTE_TRIGGERS | _DEMOTE_TRIGGERS | _ARCHIVE_TRIGGERS):
        return

    affected_task_id = _resolve_task_id(args, result)
    if not affected_task_id:
        return

    conn = _connect_board()
    if conn is None:
        return
    try:
        if tool_name in _PROMOTE_TRIGGERS:
            _handle_complete_or_block(conn, affected_task_id)
        elif tool_name in _DEMOTE_TRIGGERS:
            _handle_create_or_unblock(conn, affected_task_id)
        elif tool_name in _ARCHIVE_TRIGGERS:
            _handle_archive(conn, affected_task_id)
        conn.commit()
    except Exception:  # noqa: BLE001 — never raise from a hook
        logger.exception(
            "landfolk-orch post_tool_call(%s) handler failed for task=%s",
            tool_name,
            affected_task_id,
        )
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _handle_complete_or_block(conn: sqlite3.Connection, task_id: str) -> None:
    """A worker just released a card. Free up its assignee:

    1. Release any mutex_park lock on the assignee's other ready
       cards (they were queued behind this one).
    2. Promote the next eligible todo for the same assignee.
    """
    assignee, _status, _title = _get_assignee_and_status(conn, task_id)
    if not assignee:
        return
    if assignee in config.ORCHESTRATOR_PROFILES:
        return  # orchestrators don't get auto-promoted

    # Release mutex parks for this assignee — but only one. The next
    # gate-check tick handles the rest if multiple parked cards exist
    # (we don't want to unblock the entire queue at once).
    parked = conn.execute(
        """
        SELECT id FROM tasks
        WHERE lower(coalesce(assignee, '')) = ?
          AND status = 'ready'
          AND claim_lock LIKE ?
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
        """,
        (assignee, f"{config.MUTEX_LOCK_PREFIX}%"),
    ).fetchone()
    if parked is not None:
        release_mutex_lock(conn, parked["id"])
        return  # the released card is now the head — don't also promote a todo

    promote_next_for(conn, assignee)


def _handle_create_or_unblock(conn: sqlite3.Connection, task_id: str) -> None:
    """A card was just created or unblocked. If it landed in ``ready``
    while the assignee already has a head card, park it via
    ``claim_lock=mutex_park:<assignee>``.
    """
    assignee, status, title = _get_assignee_and_status(conn, task_id)
    if not assignee or status != "ready":
        return
    if assignee in config.ORCHESTRATOR_PROFILES:
        return  # orchestrator cards are parked by gate-check, not by hooks
    if is_chat_request(title):
        return  # chat-requests are exempt

    # Check if assignee already has a non-parked head card. Excludes self.
    rows = conn.execute(
        """
        SELECT id, title, status, claim_lock FROM tasks
        WHERE lower(coalesce(assignee, '')) = ?
          AND status IN ('ready', 'running')
          AND id != ?
        """,
        (assignee, task_id),
    ).fetchall()
    has_head = False
    for r in rows:
        if r["status"] == "running":
            has_head = True
            break
        if is_chat_request(r["title"]):
            continue
        lock = r["claim_lock"] or ""
        if lock.startswith(config.MUTEX_LOCK_PREFIX):
            continue  # parked sibling — doesn't count as a head
        has_head = True
        break
    if has_head:
        expires = int(time.time()) + config.LOCK_TTL_SECONDS
        park_via_lock(conn, task_id, assignee, "per_assignee_mutex_hook", expires)


def _handle_archive(conn: sqlite3.Connection, task_id: str) -> None:
    """A card was archived. Surface a comment on each direct child
    whose dependency chain is now broken (this card was their only
    undone parent, or one of several but they're still pending).

    We don't try to be clever about "really broken" — just leave a
    visible note so the next worker or Steward sees it.
    """
    # Find children that were linked to this task.
    child_rows = conn.execute(
        """
        SELECT c.id, c.title, c.status
        FROM task_links l
        JOIN tasks c ON c.id = l.child_id
        WHERE l.parent_id = ?
          AND c.status IN ('todo', 'ready', 'running', 'blocked')
        """,
        (task_id,),
    ).fetchall()
    if not child_rows:
        return

    now = int(time.time())
    for child in child_rows:
        try:
            conn.execute(
                "INSERT INTO task_comments (task_id, author, body, created_at) "
                "VALUES (?, ?, ?, ?)",
                (
                    child["id"],
                    "landfolk-orchestrator",
                    f"Parent task {task_id} was archived without completion. "
                    f"Verify preconditions before continuing — the dependency chain may be broken.",
                    now,
                ),
            )
            _append_event(
                conn,
                child["id"],
                "parent_archived_warning",
                {"by": "landfolk-orchestrator", "archived_parent": task_id},
            )
        except sqlite3.Error:
            # Swallow per-child failures; we'd rather warn the others.
            logger.exception("failed to warn child %s of archived parent %s", child["id"], task_id)
