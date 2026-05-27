"""Unit tests for ``orchestrator/promote.py``."""

from __future__ import annotations

import pytest

from landfolk.orchestrator import config, promote
from tests.conftest import event_kinds, get_claim_lock, get_status, insert_link, insert_task


class TestIsChatRequest:
    def test_none_returns_false(self):
        assert not promote.is_chat_request(None)

    def test_empty_returns_false(self):
        assert not promote.is_chat_request("")

    def test_prefix_match_passes(self):
        assert promote.is_chat_request("[CHAT_REQUEST] re44 says hi")

    def test_leading_whitespace_tolerated(self):
        assert promote.is_chat_request("   [CHAT_REQUEST] indented")

    def test_unprefixed_returns_false(self):
        assert not promote.is_chat_request("[SUPPLY] Mine 32 wood")


class TestHasActiveCard:
    def test_no_cards_returns_false(self, conn):
        assert not promote.has_active_card(conn, "flint")

    def test_running_card_returns_true(self, conn):
        insert_task(conn, "t1", assignee="flint", status="running")
        assert promote.has_active_card(conn, "flint")

    def test_ready_card_returns_true(self, conn):
        insert_task(conn, "t1", assignee="flint", status="ready")
        assert promote.has_active_card(conn, "flint")

    def test_only_todo_returns_false(self, conn):
        insert_task(conn, "t1", assignee="flint", status="todo")
        assert not promote.has_active_card(conn, "flint")

    def test_only_chat_request_returns_false(self, conn):
        insert_task(conn, "t1", title="[CHAT_REQUEST] hi", assignee="flint", status="ready")
        assert not promote.has_active_card(conn, "flint")

    def test_other_assignee_doesnt_block(self, conn):
        insert_task(conn, "t1", assignee="mason", status="running")
        assert not promote.has_active_card(conn, "flint")

    def test_case_insensitive_match(self, conn):
        insert_task(conn, "t1", assignee="Flint", status="running")
        assert promote.has_active_card(conn, "flint")
        assert promote.has_active_card(conn, "FLINT")

    def test_mutex_parked_card_not_active(self, conn):
        """A card with our mutex_park lock is parked, not active."""
        insert_task(
            conn,
            "t1",
            assignee="flint",
            status="ready",
            claim_lock=f"{config.MUTEX_LOCK_PREFIX}flint",
            claim_expires=9999999999,
        )
        assert not promote.has_active_card(conn, "flint")


class TestPromoteNextFor:
    def test_idle_assignee_with_one_todo_promotes_it(self, conn):
        insert_task(conn, "t1", assignee="flint", status="todo")
        result = promote.promote_next_for(conn, "flint")
        assert result == "t1"
        assert get_status(conn, "t1") == "ready"

    def test_busy_assignee_no_op(self, conn):
        insert_task(conn, "t1", assignee="flint", status="running")
        insert_task(conn, "t2", assignee="flint", status="todo")
        assert promote.promote_next_for(conn, "flint") is None
        assert get_status(conn, "t2") == "todo"

    def test_priority_ordering(self, conn, now):
        # Lower-priority card created first; higher-priority card should win.
        insert_task(conn, "low", assignee="flint", status="todo", priority=0, created_at=now)
        insert_task(conn, "high", assignee="flint", status="todo", priority=5, created_at=now + 1)
        result = promote.promote_next_for(conn, "flint")
        assert result == "high"
        assert get_status(conn, "low") == "todo"

    def test_created_at_tiebreak(self, conn, now):
        # Same priority — older card should win.
        insert_task(conn, "newer", assignee="flint", status="todo", priority=0, created_at=now + 10)
        insert_task(conn, "older", assignee="flint", status="todo", priority=0, created_at=now)
        result = promote.promote_next_for(conn, "flint")
        assert result == "older"

    def test_skips_card_with_undone_parent(self, conn):
        # Parent in 'todo' = not done; child must not promote.
        insert_task(conn, "parent", assignee="mason", status="todo")
        insert_task(conn, "child", assignee="flint", status="todo")
        insert_link(conn, "parent", "child")
        # Add a second eligible card so we can verify we skip the right one.
        insert_task(conn, "free", assignee="flint", status="todo", priority=-1)
        result = promote.promote_next_for(conn, "flint")
        assert result == "free"
        assert get_status(conn, "child") == "todo"

    def test_done_parent_does_not_block(self, conn):
        insert_task(conn, "parent", assignee="mason", status="done")
        insert_task(conn, "child", assignee="flint", status="todo")
        insert_link(conn, "parent", "child")
        result = promote.promote_next_for(conn, "flint")
        assert result == "child"

    def test_archived_parent_does_not_block(self, conn):
        insert_task(conn, "parent", assignee="mason", status="archived")
        insert_task(conn, "child", assignee="flint", status="todo")
        insert_link(conn, "parent", "child")
        result = promote.promote_next_for(conn, "flint")
        assert result == "child"

    def test_emits_promoted_event(self, conn):
        insert_task(conn, "t1", assignee="flint", status="todo")
        promote.promote_next_for(conn, "flint")
        assert "promoted" in event_kinds(conn, "t1")

    def test_idempotent_no_more_todos(self, conn):
        insert_task(conn, "t1", assignee="flint", status="todo")
        first = promote.promote_next_for(conn, "flint")
        second = promote.promote_next_for(conn, "flint")
        assert first == "t1"
        assert second is None

    def test_no_todos_returns_none(self, conn):
        result = promote.promote_next_for(conn, "flint")
        assert result is None


class TestParkViaLock:
    def test_parks_ready_card(self, conn):
        insert_task(conn, "t1", assignee="flint", status="ready")
        assert promote.park_via_lock(conn, "t1", "flint", reason="test", expires=9999999999)
        assert get_status(conn, "t1") == "ready"  # status unchanged
        assert get_claim_lock(conn, "t1") == f"{config.MUTEX_LOCK_PREFIX}flint"

    def test_no_op_on_running_card(self, conn):
        insert_task(conn, "t1", assignee="flint", status="running")
        assert not promote.park_via_lock(conn, "t1", "flint", reason="test", expires=9999999999)
        assert get_claim_lock(conn, "t1") is None

    def test_no_op_when_existing_lock(self, conn):
        insert_task(
            conn,
            "t1",
            assignee="flint",
            status="ready",
            claim_lock="worker_claim_xyz",
            claim_expires=9999999999,
        )
        # Won't overwrite a foreign lock
        assert not promote.park_via_lock(conn, "t1", "flint", reason="test", expires=9999999999)
        assert get_claim_lock(conn, "t1") == "worker_claim_xyz"

    def test_emits_mutex_parked_event(self, conn):
        insert_task(conn, "t1", assignee="flint", status="ready")
        promote.park_via_lock(conn, "t1", "flint", reason="test", expires=9999999999)
        assert "mutex_parked" in event_kinds(conn, "t1")


class TestReleaseMutexLock:
    def test_releases_mutex_lock(self, conn):
        insert_task(
            conn,
            "t1",
            assignee="flint",
            status="ready",
            claim_lock=f"{config.MUTEX_LOCK_PREFIX}flint",
            claim_expires=9999999999,
        )
        assert promote.release_mutex_lock(conn, "t1")
        assert get_claim_lock(conn, "t1") is None
        assert "mutex_released" in event_kinds(conn, "t1")

    def test_does_not_release_foreign_lock(self, conn):
        insert_task(
            conn,
            "t1",
            assignee="flint",
            status="ready",
            claim_lock="orch_continuous:steward",
            claim_expires=9999999999,
        )
        assert not promote.release_mutex_lock(conn, "t1")
        assert get_claim_lock(conn, "t1") == "orch_continuous:steward"

    def test_no_op_when_no_lock(self, conn):
        insert_task(conn, "t1", assignee="flint", status="ready")
        assert not promote.release_mutex_lock(conn, "t1")
