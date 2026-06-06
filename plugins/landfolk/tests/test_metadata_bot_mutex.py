"""Concern 5a — plugin mutex proof.

In-memory SQLite, no MC, no LLM. Asserts the canonical mutex matrix:

  - Two cards with same assignee + different [bot:...] tags promote
    concurrently (different mutex domains).
  - Two cards with same [bot:...] tag (across any assignee) serialize.
  - Cards without [bot:...] tag retain today's per-assignee behavior
    (no regression).
  - hooks.py respects the same mutex key as gate.py.

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md (Session 4).
Spec: plugins/landfolk/landfolk/orchestrator/mutex_key.py
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from landfolk.orchestrator import config, gate, hooks
from landfolk.orchestrator.mutex_key import mutex_key
from landfolk.orchestrator.promote import has_active_card, park_via_lock, promote_next_for

from tests.conftest import event_kinds, get_claim_lock, get_status, insert_task


# Many tests want a state in which orchestrators are absent so we can
# focus on the bot/assignee mutex. The fixture covers both regimes.
@pytest.fixture
def no_orch(monkeypatch):
    # test_gate.py's _reload_config can leave DISABLE_GATE / DISABLE_HOOKS
    # = True from prior reloads. Reset them explicitly so tests in this
    # module are order-independent regardless of which tests ran first.
    monkeypatch.setattr(config, "ORCHESTRATOR_PROFILES", [])
    monkeypatch.setattr(config, "DISABLE_GATE", False)
    monkeypatch.setattr(config, "DISABLE_HOOKS", False)


def _running(conn, task_id, *, title, assignee):
    insert_task(conn, task_id, title=title, assignee=assignee, status="running")


def _ready(conn, task_id, *, title, assignee, priority=0, created_at=None):
    insert_task(
        conn, task_id, title=title, assignee=assignee, status="ready",
        priority=priority, created_at=created_at,
    )


def _todo(conn, task_id, *, title, assignee, priority=0, created_at=None):
    insert_task(
        conn, task_id, title=title, assignee=assignee, status="todo",
        priority=priority, created_at=created_at,
    )


# ────────────────────────────────────────────────────────────────────
# has_active_card — domain isolation
# ────────────────────────────────────────────────────────────────────


class TestHasActiveCardByKey:
    def test_bot_tag_isolates_domains(self, conn, no_orch):
        """A running ``[bot:pip]`` card does NOT count as active for the
        ``bot:zee`` domain."""
        _running(conn, "t_pip", title="[bot:pip] go", assignee="navigator")
        assert has_active_card(conn, "bot:pip") is True
        assert has_active_card(conn, "bot:zee") is False
        # And the bare assignee domain is also unblocked because the
        # active card is in a bot-tagged domain, not the navigator queue.
        assert has_active_card(conn, "navigator") is False

    def test_untagged_card_blocks_assignee_domain_only(self, conn, no_orch):
        _running(conn, "t_nav", title="navigate", assignee="navigator")
        assert has_active_card(conn, "navigator") is True
        assert has_active_card(conn, "bot:pip") is False


# ────────────────────────────────────────────────────────────────────
# gate.py — head selection per domain
# ────────────────────────────────────────────────────────────────────


class TestGateMutexByBot:
    def test_same_assignee_different_bot_both_promote(self, conn, no_orch, now):
        """Two ready cards on assignee=navigator with bots ``pip`` and ``zee``
        — both are heads of their respective domains; neither parks."""
        _ready(conn, "t_pip", title="[bot:pip] go", assignee="navigator", created_at=now)
        _ready(conn, "t_zee", title="[bot:zee] go", assignee="navigator", created_at=now + 1)

        gate.gate_check(conn)

        # Neither card got a mutex_park lock.
        assert get_claim_lock(conn, "t_pip") is None
        assert get_claim_lock(conn, "t_zee") is None

    def test_same_bot_two_assignees_serialize(self, conn, no_orch, now):
        """Two ready cards on ``[bot:pip]`` with different assignees —
        the second-oldest is parked because they share the bot domain."""
        # navigator + miner both targeting the same body.
        _ready(conn, "t_nav_pip", title="[bot:pip] navigate", assignee="navigator", priority=10, created_at=now)
        _ready(conn, "t_min_pip", title="[bot:pip] extract", assignee="miner", priority=5, created_at=now + 1)

        gate.gate_check(conn)

        # Higher-priority becomes head (navigator), miner card parks.
        assert get_claim_lock(conn, "t_nav_pip") is None
        lock = get_claim_lock(conn, "t_min_pip")
        assert lock is not None and lock.startswith(config.MUTEX_LOCK_PREFIX)
        # Lock carries the resolved key (bot:pip), not the assignee.
        assert lock == f"{config.MUTEX_LOCK_PREFIX}bot:pip"

    def test_untagged_cards_keep_assignee_mutex(self, conn, no_orch, now):
        """Regression: cards without ``[bot:...]`` mutex on assignee, as
        they have since before Concern 5."""
        _ready(conn, "t_a", title="navigate to mark_a", assignee="flint", priority=10, created_at=now)
        _ready(conn, "t_b", title="navigate to mark_b", assignee="flint", priority=5, created_at=now + 1)

        gate.gate_check(conn)

        assert get_claim_lock(conn, "t_a") is None
        lock = get_claim_lock(conn, "t_b")
        assert lock is not None and lock.startswith(config.MUTEX_LOCK_PREFIX)
        # Lock carries the assignee key.
        assert lock == f"{config.MUTEX_LOCK_PREFIX}flint"

    def test_mixed_tagged_and_untagged_separate_domains(self, conn, no_orch, now):
        """An untagged ``navigator`` card and a ``[bot:pip]`` card with the
        same assignee are in different domains — both are heads."""
        _ready(conn, "t_plain", title="navigate", assignee="navigator", created_at=now)
        _ready(conn, "t_pip", title="[bot:pip] navigate", assignee="navigator", created_at=now + 1)

        gate.gate_check(conn)

        assert get_claim_lock(conn, "t_plain") is None
        assert get_claim_lock(conn, "t_pip") is None

    def test_running_in_bot_domain_doesnt_park_untagged_sibling(self, conn, no_orch, now):
        """A ``[bot:pip]`` running card does NOT park a plain navigator
        ready card — different domains."""
        _running(conn, "t_pip_run", title="[bot:pip] running", assignee="navigator")
        _ready(conn, "t_plain", title="navigate", assignee="navigator", created_at=now)

        gate.gate_check(conn)

        assert get_claim_lock(conn, "t_plain") is None


# ────────────────────────────────────────────────────────────────────
# promote_next_for — by domain
# ────────────────────────────────────────────────────────────────────


class TestPromoteByKey:
    def test_promotes_in_idle_bot_domain(self, conn, no_orch, now):
        """If ``bot:pip`` has only todos and no head, promote the highest-
        priority eligible todo into ready."""
        _todo(conn, "t_lo", title="[bot:pip] low-pri", assignee="navigator", priority=1, created_at=now)
        _todo(conn, "t_hi", title="[bot:pip] hi-pri", assignee="navigator", priority=10, created_at=now + 1)

        promoted = promote_next_for(conn, "bot:pip")
        assert promoted == "t_hi"
        assert get_status(conn, "t_hi") == "ready"
        assert get_status(conn, "t_lo") == "todo"

    def test_does_not_promote_when_domain_has_head(self, conn, no_orch, now):
        _running(conn, "t_head", title="[bot:pip] head", assignee="navigator")
        _todo(conn, "t_next", title="[bot:pip] next", assignee="navigator", priority=10, created_at=now)

        assert promote_next_for(conn, "bot:pip") is None
        assert get_status(conn, "t_next") == "todo"

    def test_isolation_idle_pip_promotes_even_when_zee_running(self, conn, no_orch, now):
        """``bot:pip`` has no head; ``bot:zee`` has one. The pip todo
        should promote because the domains are independent."""
        _running(conn, "t_zee_run", title="[bot:zee] running", assignee="navigator")
        _todo(conn, "t_pip_todo", title="[bot:pip] todo", assignee="navigator", priority=10, created_at=now)

        promoted = promote_next_for(conn, "bot:pip")
        assert promoted == "t_pip_todo"
        assert get_status(conn, "t_pip_todo") == "ready"

    def test_untagged_assignee_domain_unchanged(self, conn, no_orch, now):
        """Regression on the legacy path."""
        _todo(conn, "t_a", title="navigate", assignee="flint", priority=10, created_at=now)
        promoted = promote_next_for(conn, "flint")
        assert promoted == "t_a"


# ────────────────────────────────────────────────────────────────────
# hooks.py — symmetry with gate.py
# ────────────────────────────────────────────────────────────────────


class _NoCloseConn:
    """Delegates everything to the inner connection except close(), which
    becomes a no-op. The hook always closes the connection it was given;
    tests want the same db handle to stay live for post-call assertions."""

    def __init__(self, inner: sqlite3.Connection) -> None:
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def close(self) -> None:  # noqa: D401
        return None


def _stub_hooks_for_inproc(monkeypatch, conn):
    """Re-route hooks._connect_board to return `conn`. Real implementation
    opens a fresh sqlite connection through hermes_cli; tests need to
    drive against the same in-memory db."""
    wrapped = _NoCloseConn(conn)
    monkeypatch.setattr(hooks, "_connect_board", lambda: wrapped)


class TestHooksMutexByBot:
    def test_create_in_running_bot_domain_parks_the_new_card(
        self, conn, no_orch, monkeypatch, now
    ):
        """When a ``[bot:pip]`` card is already running, a freshly created
        ``[bot:pip]`` ready card on a different assignee should be parked
        by the post_tool_call hook."""
        _stub_hooks_for_inproc(monkeypatch, conn)
        _running(conn, "t_run", title="[bot:pip] navigate", assignee="navigator")
        _ready(conn, "t_new", title="[bot:pip] extract", assignee="miner", created_at=now)

        hooks.on_post_tool_call(
            tool_name="kanban_create",
            args={"task_id": "t_new"},
            result=None,
        )
        lock = get_claim_lock(conn, "t_new")
        assert lock is not None and lock.startswith(config.MUTEX_LOCK_PREFIX)
        assert lock == f"{config.MUTEX_LOCK_PREFIX}bot:pip"

    def test_create_in_different_bot_domain_no_park(
        self, conn, no_orch, monkeypatch, now
    ):
        """``[bot:pip]`` running, a fresh ``[bot:zee]`` ready card — the
        hook leaves it alone because the domains are independent."""
        _stub_hooks_for_inproc(monkeypatch, conn)
        _running(conn, "t_run", title="[bot:pip] navigate", assignee="navigator")
        _ready(conn, "t_zee", title="[bot:zee] navigate", assignee="navigator", created_at=now)

        hooks.on_post_tool_call(
            tool_name="kanban_create",
            args={"task_id": "t_zee"},
            result=None,
        )
        assert get_claim_lock(conn, "t_zee") is None

    def test_complete_unparks_sibling_in_same_bot_domain(
        self, conn, no_orch, monkeypatch, now
    ):
        """Finishing a ``[bot:pip]`` card releases the mutex park on the
        oldest sibling in the same bot domain — even across assignees."""
        _stub_hooks_for_inproc(monkeypatch, conn)
        # The card that's about to complete (running).
        _running(conn, "t_done", title="[bot:pip] navigate", assignee="navigator")
        # Parked sibling under a different assignee but same bot tag.
        marker = f"{config.MUTEX_LOCK_PREFIX}bot:pip"
        insert_task(
            conn, "t_parked",
            title="[bot:pip] extract", assignee="miner", status="ready",
            claim_lock=marker, claim_expires=now + 9999,
        )

        # Simulate the tool call closing t_done. The harness here just
        # flips its status and lets the hook react.
        conn.execute("UPDATE tasks SET status = 'done' WHERE id = ?", ("t_done",))
        hooks.on_post_tool_call(
            tool_name="kanban_complete",
            args={"task_id": "t_done"},
            result=None,
        )

        # Sibling lock released.
        assert get_claim_lock(conn, "t_parked") is None
        # And we left a mutex_released event.
        assert "mutex_released" in event_kinds(conn, "t_parked")

    def test_complete_untagged_still_unparks_assignee_sibling(
        self, conn, no_orch, monkeypatch, now
    ):
        """Regression: untagged completion path still unparks an untagged
        sibling on the same assignee."""
        _stub_hooks_for_inproc(monkeypatch, conn)
        _running(conn, "t_done", title="navigate", assignee="flint")
        marker = f"{config.MUTEX_LOCK_PREFIX}flint"
        insert_task(
            conn, "t_parked",
            title="navigate again", assignee="flint", status="ready",
            claim_lock=marker, claim_expires=now + 9999,
        )

        conn.execute("UPDATE tasks SET status = 'done' WHERE id = ?", ("t_done",))
        hooks.on_post_tool_call(
            tool_name="kanban_complete",
            args={"task_id": "t_done"},
            result=None,
        )
        assert get_claim_lock(conn, "t_parked") is None
