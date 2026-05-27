"""Unit tests for ``orchestrator/hooks.py``.

We don't go through Hermes' kanban_db.connect() — the hook module
imports it lazily, so we monkeypatch ``_connect_board`` to return our
test fixture connection.
"""

from __future__ import annotations

import importlib

import pytest

from landfolk.orchestrator import config, hooks
from tests.conftest import event_kinds, get_claim_lock, get_status, insert_link, insert_task


class _NoCloseConn:
    """Thin wrapper that proxies to the underlying sqlite3 connection
    but ignores ``close()``. sqlite3.Connection.close is read-only so
    we can't monkeypatch the method directly — wrap it instead."""

    def __init__(self, real):
        self._real = real

    def __getattr__(self, name):
        return getattr(self._real, name)

    def close(self):
        pass


@pytest.fixture
def patched_hooks(monkeypatch, conn):
    """Patch hooks._connect_board to return our temp DB.

    The hook closes its connection in `finally`; the wrapper ignores
    close() so the shared test connection survives multiple hook
    invocations within one test.
    """
    wrapped = _NoCloseConn(conn)
    monkeypatch.setattr(hooks, "_connect_board", lambda: wrapped)
    return hooks


class TestResolveTaskId:
    def test_from_args_task_id(self):
        assert hooks._resolve_task_id({"task_id": "t1"}, None) == "t1"

    def test_from_args_id_fallback(self):
        assert hooks._resolve_task_id({"id": "t1"}, None) == "t1"

    def test_from_result_top_level(self):
        assert hooks._resolve_task_id({}, {"task_id": "t1"}) == "t1"

    def test_from_result_nested_data(self):
        assert hooks._resolve_task_id({}, {"data": {"task_id": "t1"}}) == "t1"

    def test_returns_none_when_missing(self):
        assert hooks._resolve_task_id({}, {}) is None

    def test_args_wins_over_result(self):
        assert hooks._resolve_task_id({"task_id": "from_args"}, {"task_id": "from_result"}) == "from_args"


class TestCompleteBlockPromote:
    def test_complete_releases_mutex_park_first(self, patched_hooks, conn):
        """If a parked sibling exists for the same assignee, release its
        lock (the parked card becomes the new head) rather than
        promoting a fresh todo."""
        insert_task(conn, "t_done", assignee="flint", status="done")
        insert_task(
            conn,
            "t_parked",
            assignee="flint",
            status="ready",
            claim_lock=f"{config.MUTEX_LOCK_PREFIX}flint",
            claim_expires=9999999999,
        )
        insert_task(conn, "t_todo", assignee="flint", status="todo")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_complete", args={"task_id": "t_done"}, result={}
        )
        # Parked card released
        assert get_claim_lock(conn, "t_parked") is None
        # Todo NOT promoted (parked card is now the head)
        assert get_status(conn, "t_todo") == "todo"

    def test_complete_promotes_next_eligible_todo_when_no_parks(self, patched_hooks, conn):
        insert_task(conn, "t_running", assignee="flint", status="done")
        insert_task(conn, "t_queued", assignee="flint", status="todo")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_complete", args={"task_id": "t_running"}, result={}
        )
        assert get_status(conn, "t_queued") == "ready"

    def test_block_also_promotes(self, patched_hooks, conn):
        insert_task(conn, "t_blocked", assignee="flint", status="blocked")
        insert_task(conn, "t_queued", assignee="flint", status="todo")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_block", args={"task_id": "t_blocked"}, result={}
        )
        assert get_status(conn, "t_queued") == "ready"

    def test_complete_on_orchestrator_no_promote(self, patched_hooks, conn):
        insert_task(conn, "s_done", assignee="steward", status="done")
        insert_task(conn, "s_queued", assignee="steward", status="todo")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_complete", args={"task_id": "s_done"}, result={}
        )
        # Orchestrators don't auto-promote
        assert get_status(conn, "s_queued") == "todo"

    def test_unknown_tool_no_op(self, patched_hooks, conn):
        insert_task(conn, "t_queued", assignee="flint", status="todo")
        patched_hooks.on_post_tool_call(tool_name="write_file", args={"path": "/tmp/foo"}, result="")
        assert get_status(conn, "t_queued") == "todo"


class TestCreateUnblockPark:
    """Create/unblock-into-busy parks the new card via mutex_park lock
    (status stays `ready`, claim_lock applied)."""

    def test_create_into_busy_assignee_parks_new_card(self, patched_hooks, conn):
        insert_task(conn, "t_running", assignee="flint", status="running")
        insert_task(conn, "t_new", assignee="flint", status="ready")  # freshly created
        patched_hooks.on_post_tool_call(
            tool_name="kanban_create",
            args={"title": "[SUPPLY] wood"},
            result={"task_id": "t_new", "status": "ready"},
        )
        assert get_status(conn, "t_new") == "ready"
        assert (get_claim_lock(conn, "t_new") or "").startswith(config.MUTEX_LOCK_PREFIX)

    def test_create_into_idle_assignee_stays_unlocked(self, patched_hooks, conn):
        insert_task(conn, "t_new", assignee="flint", status="ready")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_create", args={}, result={"task_id": "t_new", "status": "ready"}
        )
        assert get_status(conn, "t_new") == "ready"
        assert get_claim_lock(conn, "t_new") is None

    def test_unblock_into_busy_assignee_parks(self, patched_hooks, conn):
        insert_task(conn, "t_running", assignee="flint", status="running")
        insert_task(conn, "t_unblocked", assignee="flint", status="ready")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_unblock", args={"task_id": "t_unblocked"}, result={}
        )
        assert (get_claim_lock(conn, "t_unblocked") or "").startswith(config.MUTEX_LOCK_PREFIX)

    def test_chat_request_exempt_from_park(self, patched_hooks, conn):
        insert_task(conn, "t_running", assignee="flint", status="running")
        insert_task(conn, "t_chat", title="[CHAT_REQUEST] hi", assignee="flint", status="ready")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_create", args={}, result={"task_id": "t_chat", "status": "ready"}
        )
        assert get_claim_lock(conn, "t_chat") is None

    def test_orchestrator_card_never_parked_by_hook(self, patched_hooks, conn):
        insert_task(conn, "s_active", assignee="steward", status="running")
        insert_task(conn, "s_new", assignee="steward", status="ready")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_create", args={}, result={"task_id": "s_new"}
        )
        # Orchestrator cards parked by gate-check (with orch_continuous: lock),
        # not by hooks (which would use mutex_park: prefix).
        assert get_claim_lock(conn, "s_new") is None

    def test_create_with_no_assignee_no_op(self, patched_hooks, conn):
        insert_task(conn, "t_new", assignee=None, status="ready")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_create", args={}, result={"task_id": "t_new"}
        )
        assert get_claim_lock(conn, "t_new") is None

    def test_parked_sibling_not_treated_as_head(self, patched_hooks, conn):
        """If the only other ready card is mutex-parked, the new card
        should NOT be parked — it becomes the head."""
        insert_task(
            conn,
            "t_parked",
            assignee="flint",
            status="ready",
            claim_lock=f"{config.MUTEX_LOCK_PREFIX}flint",
            claim_expires=9999999999,
        )
        insert_task(conn, "t_new", assignee="flint", status="ready")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_create", args={}, result={"task_id": "t_new"}
        )
        assert get_claim_lock(conn, "t_new") is None


class TestArchiveWarning:
    def test_archive_comments_children(self, patched_hooks, conn):
        insert_task(conn, "parent", assignee="mason", status="archived")
        insert_task(conn, "child_todo", assignee="flint", status="todo")
        insert_task(conn, "child_ready", assignee="flint", status="ready")
        insert_link(conn, "parent", "child_todo")
        insert_link(conn, "parent", "child_ready")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_archive", args={"task_id": "parent"}, result={}
        )
        # Both children get a comment
        comments_todo = conn.execute(
            "SELECT count(*) AS n FROM task_comments WHERE task_id = ?", ("child_todo",)
        ).fetchone()
        comments_ready = conn.execute(
            "SELECT count(*) AS n FROM task_comments WHERE task_id = ?", ("child_ready",)
        ).fetchone()
        assert comments_todo["n"] == 1
        assert comments_ready["n"] == 1
        assert "parent_archived_warning" in event_kinds(conn, "child_todo")
        assert "parent_archived_warning" in event_kinds(conn, "child_ready")

    def test_archive_skips_done_children(self, patched_hooks, conn):
        insert_task(conn, "parent", assignee="mason", status="archived")
        insert_task(conn, "child_done", assignee="flint", status="done")
        insert_link(conn, "parent", "child_done")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_archive", args={"task_id": "parent"}, result={}
        )
        comments = conn.execute(
            "SELECT count(*) AS n FROM task_comments WHERE task_id = ?", ("child_done",)
        ).fetchone()
        assert comments["n"] == 0

    def test_archive_no_children_no_op(self, patched_hooks, conn):
        insert_task(conn, "parent", assignee="mason", status="archived")
        patched_hooks.on_post_tool_call(
            tool_name="kanban_archive", args={"task_id": "parent"}, result={}
        )
        # No exception; nothing to verify beyond that


class TestKillSwitch:
    def test_disable_hooks_no_op(self, monkeypatch, conn):
        monkeypatch.setenv("LANDFOLK_DISABLE_HOOKS", "1")
        import landfolk.orchestrator.config as cfg
        import landfolk.orchestrator.hooks as hooks_mod
        importlib.reload(cfg)
        importlib.reload(hooks_mod)
        monkeypatch.setattr(hooks_mod, "_connect_board", lambda: conn)
        insert_task(conn, "t_done", assignee="flint", status="done")
        insert_task(conn, "t_queued", assignee="flint", status="todo")
        hooks_mod.on_post_tool_call(
            tool_name="kanban_complete", args={"task_id": "t_done"}, result={}
        )
        # Hook should be a no-op
        assert get_status(conn, "t_queued") == "todo"

    def test_no_task_id_no_op(self, patched_hooks, conn):
        # Doesn't crash; just exits early
        patched_hooks.on_post_tool_call(tool_name="kanban_complete", args={}, result={})
