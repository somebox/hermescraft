"""W2-NAV-009 regression: pre-park excess eligible todos.

Background: dispatch_once (core Hermes) calls recompute_ready which
promotes ALL eligible todos → ready in one shot, ignoring mutex_key.
The dispatcher's claim loop then claims them all before the NEXT
gate-check tick can park duplicates. The race left the proc-nav-1780970837
trial with two `[bot:mox]` cards running concurrently, defeating the
per-bot serialization the mutex was supposed to enforce.

Fix: gate-check's Step 5b pre-parks excess eligible todos by writing
``claim_lock=mutex_park:<key>`` while they're still in `todo`. The
lock survives recompute_ready's status flip (it only touches `status`),
so the dispatcher's `WHERE claim_lock IS NULL` selector skips them.

These tests verify the new behavior without importing Hermes.
"""

from __future__ import annotations

import sqlite3

import pytest

from landfolk.orchestrator import config, gate
from landfolk.orchestrator.promote import has_active_card

from tests.conftest import event_kinds, get_claim_lock, get_status, insert_link, insert_task


@pytest.fixture
def no_orch(monkeypatch):
    monkeypatch.setattr(config, "ORCHESTRATOR_PROFILES", [])
    monkeypatch.setattr(config, "DISABLE_GATE", False)
    monkeypatch.setattr(config, "DISABLE_HOOKS", False)


def _todo(conn, task_id, *, title, assignee, priority=0, created_at=None):
    insert_task(
        conn, task_id, title=title, assignee=assignee, status="todo",
        priority=priority, created_at=created_at,
    )


def _ready(conn, task_id, *, title, assignee, priority=0, created_at=None, claim_lock=None):
    insert_task(
        conn, task_id, title=title, assignee=assignee, status="ready",
        priority=priority, created_at=created_at, claim_lock=claim_lock,
    )


def _running(conn, task_id, *, title, assignee):
    insert_task(conn, task_id, title=title, assignee=assignee, status="running")


def _done(conn, task_id):
    insert_task(conn, task_id, title="parent", assignee=None, status="done")


def _simulate_recompute_ready(conn):
    """Mimic core-Hermes ``recompute_ready`` exactly: any todo whose parents
    are all done/archived flips to ready. claim_lock is NOT touched.

    The point of this helper is to verify that the gate-check's todo
    pre-park survives the status flip — without this, the test couldn't
    distinguish "pre-park worked" from "pre-park got wiped".
    """
    rows = conn.execute(
        "SELECT id FROM tasks WHERE status = 'todo'"
    ).fetchall()
    for row in rows:
        task_id = row["id"]
        parents = conn.execute(
            "SELECT t.status FROM tasks t "
            "JOIN task_links l ON l.parent_id = t.id "
            "WHERE l.child_id = ?",
            (task_id,),
        ).fetchall()
        if not parents or all(p["status"] in ("done", "archived") for p in parents):
            conn.execute(
                "UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'todo'",
                (task_id,),
            )


def _simulate_claim_loop(conn):
    """Mimic core-Hermes dispatcher claim loop: pick all ready cards
    whose claim_lock IS NULL and transition them to running.

    Returns the list of claimed task_ids in claim order.
    """
    rows = conn.execute(
        "SELECT id FROM tasks "
        "WHERE status = 'ready' AND claim_lock IS NULL "
        "ORDER BY priority DESC, created_at ASC"
    ).fetchall()
    claimed: list[str] = []
    for row in rows:
        cur = conn.execute(
            "UPDATE tasks SET status = 'running' "
            "WHERE id = ? AND status = 'ready' AND claim_lock IS NULL",
            (row["id"],),
        )
        if cur.rowcount:
            claimed.append(row["id"])
    return claimed


class TestTodoPrePark:
    def test_three_bot_mox_todos_one_eligible_promotes_two_pre_parked(self, conn, no_orch, now):
        """Three [bot:mox] todos all become eligible at once (shared parent
        just completed). Gate-check must pre-park 2 of them so dispatcher's
        recompute_ready leaves only one unparked."""
        # Parent already done — all three todos are eligible to promote.
        _done(conn, "t_parent")
        _todo(conn, "t_mox_seg1", title="[bot:mox] [BUILD] clear segment 1",
              assignee="builder-mox", priority=10, created_at=now)
        insert_link(conn, "t_parent", "t_mox_seg1")
        _todo(conn, "t_mox_seg2", title="[bot:mox] [BUILD] clear segment 2",
              assignee="builder-mox", priority=10, created_at=now + 1)
        insert_link(conn, "t_parent", "t_mox_seg2")
        _todo(conn, "t_mox_seg3", title="[bot:mox] [BUILD] clear segment 3",
              assignee="builder-mox", priority=10, created_at=now + 2)
        insert_link(conn, "t_parent", "t_mox_seg3")

        stats = gate.gate_check(conn)

        # Step 5b should have parked the two older-tiebreaker losers.
        # Step 5 (promote_next_for) may have already promoted seg1 to ready;
        # the other two stay todo with claim_lock=mutex_park:bot:mox.
        marker = f"{config.MUTEX_LOCK_PREFIX}bot:mox"
        # The head is seg1 (highest priority, oldest created_at). It should
        # NOT be parked.
        assert get_claim_lock(conn, "t_mox_seg1") is None
        # The other two must carry the mutex park lock now.
        assert get_claim_lock(conn, "t_mox_seg2") == marker
        assert get_claim_lock(conn, "t_mox_seg3") == marker
        # Stats reflect at least 2 mutex_park writes.
        assert stats["mutex_parked"] >= 2

    def test_pre_park_survives_recompute_ready_and_dispatch_claims_only_one(
        self, conn, no_orch, now,
    ):
        """End-to-end: pre-park → recompute_ready → claim loop should claim
        exactly ONE [bot:mox] card, even though all three were eligible
        and recompute_ready promotes all three to ready."""
        _done(conn, "t_parent")
        _todo(conn, "t_mox_A", title="[bot:mox] task A", assignee="builder-mox",
              priority=10, created_at=now)
        insert_link(conn, "t_parent", "t_mox_A")
        _todo(conn, "t_mox_B", title="[bot:mox] task B", assignee="builder-mox",
              priority=10, created_at=now + 1)
        insert_link(conn, "t_parent", "t_mox_B")
        _todo(conn, "t_mox_C", title="[bot:mox] task C", assignee="builder-mox",
              priority=10, created_at=now + 2)
        insert_link(conn, "t_parent", "t_mox_C")

        # Gate-check: pre-parks B + C.
        gate.gate_check(conn)
        # Simulate dispatch_once: recompute_ready flips ALL todos to ready
        # (it ignores mutex_key). claim_lock survives the flip.
        _simulate_recompute_ready(conn)
        # All three should now be 'ready', but only A is unlocked.
        assert get_status(conn, "t_mox_A") == "ready"
        assert get_status(conn, "t_mox_B") == "ready"
        assert get_status(conn, "t_mox_C") == "ready"
        marker = f"{config.MUTEX_LOCK_PREFIX}bot:mox"
        assert get_claim_lock(conn, "t_mox_A") is None
        assert get_claim_lock(conn, "t_mox_B") == marker
        assert get_claim_lock(conn, "t_mox_C") == marker

        # Now the dispatcher's claim loop. It must claim exactly one.
        claimed = _simulate_claim_loop(conn)
        assert claimed == ["t_mox_A"], f"expected only t_mox_A claimed, got {claimed}"
        assert get_status(conn, "t_mox_A") == "running"
        assert get_status(conn, "t_mox_B") == "ready"  # parked, not claimed
        assert get_status(conn, "t_mox_C") == "ready"

    def test_pre_park_skips_ineligible_todos(self, conn, no_orch, now):
        """A todo whose parents are not all done shouldn't be touched —
        recompute_ready won't promote it anyway, so parking is wasted."""
        # Parent NOT done — child is ineligible.
        insert_task(conn, "t_parent_running", title="p", assignee=None, status="running")
        _todo(conn, "t_mox_blocked", title="[bot:mox] blocked",
              assignee="builder-mox", priority=10, created_at=now)
        insert_link(conn, "t_parent_running", "t_mox_blocked")
        # Another eligible [bot:mox] todo with no parent — this should be promoted.
        _todo(conn, "t_mox_free", title="[bot:mox] free",
              assignee="builder-mox", priority=10, created_at=now + 1)

        gate.gate_check(conn)

        # t_mox_free is the new head; no lock.
        assert get_claim_lock(conn, "t_mox_free") is None
        # t_mox_blocked is ineligible (parent still running). Should NOT be
        # pre-parked — recompute_ready wouldn't promote it anyway.
        assert get_claim_lock(conn, "t_mox_blocked") is None
        # Still todo (no head promoted it because gate's promote_next_for
        # already grabbed t_mox_free).

    def test_pre_park_running_active_card_parks_all_eligible_todos(self, conn, no_orch, now):
        """If a [bot:mox] is already running, gate-check should park ALL
        eligible todos (no head — running already IS the head)."""
        _running(conn, "t_mox_running", title="[bot:mox] in flight", assignee="builder-mox")
        _done(conn, "t_parent")
        _todo(conn, "t_mox_T1", title="[bot:mox] T1", assignee="builder-mox",
              priority=10, created_at=now)
        insert_link(conn, "t_parent", "t_mox_T1")
        _todo(conn, "t_mox_T2", title="[bot:mox] T2", assignee="builder-mox",
              priority=10, created_at=now + 1)
        insert_link(conn, "t_parent", "t_mox_T2")

        gate.gate_check(conn)

        marker = f"{config.MUTEX_LOCK_PREFIX}bot:mox"
        # Both eligible todos parked (running is the head).
        assert get_claim_lock(conn, "t_mox_T1") == marker
        assert get_claim_lock(conn, "t_mox_T2") == marker
        # And the active card has no mutex lock (it's running, not a parked sibling).
        assert get_claim_lock(conn, "t_mox_running") is None

    def test_pre_park_different_bots_dont_interfere(self, conn, no_orch, now):
        """Two [bot:mox] and one [bot:pip] all eligible — pip should NOT
        be pre-parked (different mutex domain)."""
        _done(conn, "t_parent")
        _todo(conn, "t_mox_A", title="[bot:mox] A", assignee="builder-mox",
              priority=10, created_at=now)
        insert_link(conn, "t_parent", "t_mox_A")
        _todo(conn, "t_mox_B", title="[bot:mox] B", assignee="builder-mox",
              priority=10, created_at=now + 1)
        insert_link(conn, "t_parent", "t_mox_B")
        _todo(conn, "t_pip_A", title="[bot:pip] A", assignee="builder",
              priority=10, created_at=now + 2)
        insert_link(conn, "t_parent", "t_pip_A")

        gate.gate_check(conn)

        # mox A is head (no lock). mox B is parked.
        assert get_claim_lock(conn, "t_mox_A") is None
        assert get_claim_lock(conn, "t_mox_B") == f"{config.MUTEX_LOCK_PREFIX}bot:mox"
        # pip A is its own head (only one in that domain) — no lock.
        assert get_claim_lock(conn, "t_pip_A") is None

    def test_pre_park_skips_chat_requests(self, conn, no_orch, now):
        """[CHAT_REQUEST] todos are exempt from the mutex cap — they should
        not be pre-parked even if another eligible todo exists on the same
        assignee. The convention is `[CHAT_REQUEST]` first in the title
        (config.CHAT_REQUEST_PREFIX is matched via str.startswith)."""
        _done(conn, "t_parent")
        _todo(conn, "t_normal", title="navigate to mark_x", assignee="navigator",
              priority=10, created_at=now)
        insert_link(conn, "t_parent", "t_normal")
        _todo(conn, "t_chat", title="[CHAT_REQUEST] @flint, where are you?",
              assignee="navigator", priority=10, created_at=now + 1)
        insert_link(conn, "t_parent", "t_chat")

        gate.gate_check(conn)

        # The chat request stays unparked even though it shares the
        # navigator mutex key with t_normal.
        assert get_claim_lock(conn, "t_chat") is None

    def test_pre_park_records_event(self, conn, no_orch, now):
        """The pre-park writes a `mutex_parked` event with reason todo_pre_park."""
        _done(conn, "t_parent")
        _todo(conn, "t_mox_A", title="[bot:mox] A", assignee="builder-mox", created_at=now)
        insert_link(conn, "t_parent", "t_mox_A")
        _todo(conn, "t_mox_B", title="[bot:mox] B", assignee="builder-mox", created_at=now + 1)
        insert_link(conn, "t_parent", "t_mox_B")

        gate.gate_check(conn)

        kinds = event_kinds(conn, "t_mox_B")
        assert "mutex_parked" in kinds

    def test_pre_park_idempotent_across_ticks(self, conn, no_orch, now):
        """Running gate_check twice produces the same state (no double-park,
        no thrash)."""
        _done(conn, "t_parent")
        for tid, dz in [("t_mox_A", 0), ("t_mox_B", 1), ("t_mox_C", 2)]:
            _todo(conn, tid, title=f"[bot:mox] {tid}", assignee="builder-mox",
                  priority=10, created_at=now + dz)
            insert_link(conn, "t_parent", tid)

        gate.gate_check(conn)
        first_locks = {
            tid: get_claim_lock(conn, tid)
            for tid in ("t_mox_A", "t_mox_B", "t_mox_C")
        }
        gate.gate_check(conn)
        second_locks = {
            tid: get_claim_lock(conn, tid)
            for tid in ("t_mox_A", "t_mox_B", "t_mox_C")
        }
        assert first_locks == second_locks
