"""Unit tests for ``orchestrator/gate.py``."""

from __future__ import annotations

import importlib

import pytest

from landfolk.orchestrator import gate
from tests.conftest import event_kinds, get_claim_lock, get_status, insert_task


def _reload_config(monkeypatch, **env):
    """Reload config + gate modules after mutating env so module-level
    constants pick up the new values."""
    for k, v in env.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    import landfolk.orchestrator.config as cfg
    import landfolk.orchestrator.gate as gate_mod
    import landfolk.orchestrator.promote as promote_mod
    importlib.reload(cfg)
    importlib.reload(promote_mod)
    importlib.reload(gate_mod)
    return gate_mod


class TestParkPass:
    """The gate parks excess ready cards via ``claim_lock=mutex_park:<assignee>``.
    Cards stay in ``ready`` status (visible in the queue) but the
    dispatcher's ``WHERE claim_lock IS NULL`` selector skips them.
    Status-demote was the original design but lost to ``recompute_ready``
    auto-promoting parent-less todos on every ``kanban list`` call.
    """

    def test_one_running_three_ready_parks_three(self, conn):
        from landfolk.orchestrator import config as cfg
        insert_task(conn, "run", assignee="flint", status="running")
        insert_task(conn, "r1", assignee="flint", status="ready", priority=3)
        insert_task(conn, "r2", assignee="flint", status="ready", priority=2)
        insert_task(conn, "r3", assignee="flint", status="ready", priority=1)
        stats = gate.gate_check(conn)
        assert stats["mutex_parked"] == 3
        assert get_status(conn, "run") == "running"
        # All three stay ready, just locked
        for tid in ("r1", "r2", "r3"):
            assert get_status(conn, tid) == "ready"
            assert (get_claim_lock(conn, tid) or "").startswith(cfg.MUTEX_LOCK_PREFIX)

    def test_four_ready_no_running_keeps_highest_priority(self, conn, now):
        from landfolk.orchestrator import config as cfg
        # priority wins; among equal-priority, older wins.
        insert_task(conn, "low_old", assignee="flint", status="ready", priority=0, created_at=now)
        insert_task(conn, "high1", assignee="flint", status="ready", priority=5, created_at=now + 5)
        insert_task(conn, "high2", assignee="flint", status="ready", priority=5, created_at=now + 1)
        insert_task(conn, "low_new", assignee="flint", status="ready", priority=0, created_at=now + 10)
        stats = gate.gate_check(conn)
        assert stats["mutex_parked"] == 3
        # high2 (priority=5, oldest created_at) is the head — no lock
        assert get_claim_lock(conn, "high2") is None
        # others are mutex-parked
        for tid in ("high1", "low_old", "low_new"):
            assert (get_claim_lock(conn, tid) or "").startswith(cfg.MUTEX_LOCK_PREFIX)

    def test_running_card_never_parked(self, conn):
        insert_task(conn, "run1", assignee="flint", status="running", priority=1)
        insert_task(conn, "run2", assignee="flint", status="running", priority=5)
        stats = gate.gate_check(conn)
        assert stats["mutex_parked"] == 0
        assert get_claim_lock(conn, "run1") is None
        assert get_claim_lock(conn, "run2") is None

    def test_chat_request_stays_unlocked_alongside_running(self, conn):
        from landfolk.orchestrator import config as cfg
        insert_task(conn, "work", assignee="flint", status="running")
        insert_task(conn, "chat", title="[CHAT_REQUEST] hi", assignee="flint", status="ready")
        insert_task(conn, "queued", assignee="flint", status="ready")
        stats = gate.gate_check(conn)
        assert get_claim_lock(conn, "chat") is None  # chat exempt
        assert (get_claim_lock(conn, "queued") or "").startswith(cfg.MUTEX_LOCK_PREFIX)
        assert stats["mutex_parked"] == 1

    def test_different_assignees_independent(self, conn):
        from landfolk.orchestrator import config as cfg
        insert_task(conn, "f_run", assignee="flint", status="running")
        insert_task(conn, "f_q", assignee="flint", status="ready")
        insert_task(conn, "m_run", assignee="mason", status="running")
        insert_task(conn, "m_q", assignee="mason", status="ready")
        gate.gate_check(conn)
        assert (get_claim_lock(conn, "f_q") or "").startswith(cfg.MUTEX_LOCK_PREFIX)
        assert (get_claim_lock(conn, "m_q") or "").startswith(cfg.MUTEX_LOCK_PREFIX)

    def test_emits_mutex_parked_events(self, conn):
        insert_task(conn, "run", assignee="flint", status="running")
        insert_task(conn, "q", assignee="flint", status="ready")
        gate.gate_check(conn)
        assert "mutex_parked" in event_kinds(conn, "q")

    def test_existing_worker_claim_lock_not_overwritten(self, conn, now):
        # If a real worker claim is in-flight, the gate must not touch it.
        insert_task(conn, "run", assignee="flint", status="running")
        insert_task(
            conn,
            "claimed",
            assignee="flint",
            status="ready",
            claim_lock="real_worker_lock_xyz",
            claim_expires=now + 999,
        )
        stats = gate.gate_check(conn)
        # No park attempted on the foreign-locked card
        assert get_claim_lock(conn, "claimed") == "real_worker_lock_xyz"


class TestMutexRelease:
    def test_release_when_assignee_becomes_idle(self, conn):
        """A mutex_parked card whose siblings have all gone away gets its lock released."""
        from landfolk.orchestrator import config as cfg
        # Only the parked card exists for this assignee — no running, no head.
        insert_task(
            conn,
            "parked",
            assignee="flint",
            status="ready",
            claim_lock=f"{cfg.MUTEX_LOCK_PREFIX}flint",
            claim_expires=9999999999,
        )
        stats = gate.gate_check(conn)
        assert stats["mutex_released"] == 1
        assert get_claim_lock(conn, "parked") is None

    def test_keep_park_when_running_sibling_exists(self, conn):
        from landfolk.orchestrator import config as cfg
        insert_task(conn, "run", assignee="flint", status="running")
        insert_task(
            conn,
            "parked",
            assignee="flint",
            status="ready",
            claim_lock=f"{cfg.MUTEX_LOCK_PREFIX}flint",
            claim_expires=9999999999,
        )
        stats = gate.gate_check(conn)
        assert stats["mutex_released"] == 0
        assert (get_claim_lock(conn, "parked") or "").startswith(cfg.MUTEX_LOCK_PREFIX)

    def test_release_emits_event(self, conn):
        from landfolk.orchestrator import config as cfg
        insert_task(
            conn,
            "parked",
            assignee="flint",
            status="ready",
            claim_lock=f"{cfg.MUTEX_LOCK_PREFIX}flint",
            claim_expires=9999999999,
        )
        gate.gate_check(conn)
        assert "mutex_released" in event_kinds(conn, "parked")


class TestPromotePass:
    def test_idle_assignee_with_todo_promotes(self, conn):
        insert_task(conn, "t1", assignee="flint", status="todo")
        stats = gate.gate_check(conn)
        assert stats["promoted"] == 1
        assert get_status(conn, "t1") == "ready"

    def test_busy_assignee_no_promote(self, conn):
        insert_task(conn, "run", assignee="flint", status="running")
        insert_task(conn, "queued", assignee="flint", status="todo")
        stats = gate.gate_check(conn)
        assert stats["promoted"] == 0
        assert get_status(conn, "queued") == "todo"

    def test_park_then_promote_for_different_assignees(self, conn):
        from landfolk.orchestrator import config as cfg
        insert_task(conn, "f_run", assignee="flint", status="running")
        insert_task(conn, "f_excess", assignee="flint", status="ready")
        insert_task(conn, "m_idle_todo", assignee="mason", status="todo")
        stats = gate.gate_check(conn)
        assert stats["mutex_parked"] == 1
        assert stats["promoted"] == 1
        assert (get_claim_lock(conn, "f_excess") or "").startswith(cfg.MUTEX_LOCK_PREFIX)
        assert get_status(conn, "m_idle_todo") == "ready"


class TestOrchestratorPark:
    def test_steward_ready_card_gets_locked(self, conn):
        insert_task(conn, "s1", assignee="steward", status="ready")
        stats = gate.gate_check(conn)
        assert stats["orch_parked"] == 1
        lock = get_claim_lock(conn, "s1")
        assert lock is not None
        assert lock.startswith("orch_continuous:")
        assert get_status(conn, "s1") == "ready"  # still ready, just claim-locked

    def test_already_locked_steward_card_not_reparked(self, conn, now):
        insert_task(
            conn,
            "s1",
            assignee="steward",
            status="ready",
            claim_lock="orch_continuous:steward",
            claim_expires=now + 999,
        )
        stats = gate.gate_check(conn)
        assert stats["orch_parked"] == 0

    def test_reassigned_card_releases_lock(self, conn, now):
        # Card was a steward card, now reassigned to flint, but the
        # stale orch_continuous: lock survives. Gate-check must release it.
        insert_task(
            conn,
            "t1",
            assignee="flint",
            status="ready",
            claim_lock="orch_continuous:steward",
            claim_expires=now + 999,
        )
        stats = gate.gate_check(conn)
        assert stats["orch_released"] == 1
        assert get_claim_lock(conn, "t1") is None

    def test_expired_lock_released(self, conn, now):
        insert_task(
            conn,
            "s1",
            assignee="steward",
            status="ready",
            claim_lock="orch_continuous:steward",
            claim_expires=now - 100,
        )
        stats = gate.gate_check(conn)
        # Expired → released, then re-parked in same tick. Net: lock fresh.
        assert stats["orch_released"] >= 1
        # Re-applied with fresh TTL
        lock = get_claim_lock(conn, "s1")
        assert lock == "orch_continuous:steward"


class TestIdempotency:
    def test_second_run_no_op(self, conn):
        insert_task(conn, "run", assignee="flint", status="running")
        insert_task(conn, "r1", assignee="flint", status="ready")
        insert_task(conn, "r2", assignee="flint", status="ready")
        first = gate.gate_check(conn)
        second = gate.gate_check(conn)
        assert first["mutex_parked"] == 2
        assert second["mutex_parked"] == 0
        assert second["mutex_released"] == 0
        assert second["promoted"] == 0

    def test_empty_board_no_op(self, conn):
        stats = gate.gate_check(conn)
        assert stats == {
            "orch_released": 0,
            "orch_parked": 0,
            "mutex_released": 0,
            "mutex_parked": 0,
            "promoted": 0,
            "errors": 0,
        }


class TestKillSwitch:
    def test_disable_gate_returns_zero_stats(self, conn, monkeypatch):
        gate_mod = _reload_config(monkeypatch, LANDFOLK_DISABLE_GATE="1")
        insert_task(conn, "run", assignee="flint", status="running")
        insert_task(conn, "excess", assignee="flint", status="ready")
        stats = gate_mod.gate_check(conn)
        assert all(v == 0 for v in stats.values())
        # No park happened
        assert get_claim_lock(conn, "excess") is None
        assert get_status(conn, "excess") == "ready"


class TestFormatStats:
    def test_format_emits_keys(self):
        line = gate.format_stats(
            {"promoted": 1, "mutex_parked": 2, "mutex_released": 3, "orch_parked": 4, "orch_released": 5, "errors": 0}
        )
        assert "promoted=1" in line
        assert "mutex_parked=2" in line
        assert "mutex_released=3" in line
        assert "orch_parked=4" in line
        assert "orch_released=5" in line
        assert "errors" not in line  # suppressed when 0

    def test_format_shows_errors_when_present(self):
        line = gate.format_stats({"promoted": 0, "mutex_parked": 0, "mutex_released": 0, "orch_parked": 0, "orch_released": 0, "errors": 2})
        assert "errors=2" in line
