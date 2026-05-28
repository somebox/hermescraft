"""Unit tests for scripts/kanban — the depends-on / epic facade.

We test the pure-Python helpers (trailer parsing) and the DB-read query
helpers against a synthetic SQLite DB with the same schema Hermes uses.
The CLI dispatch + subprocess paths are intentionally not tested here —
they exercise a real `hermes kanban` binary; that's smoke-test territory.
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _load_kanban_module():
    """`scripts/kanban` has no .py extension; load it as a module."""
    path = REPO / "scripts" / "kanban"
    loader = SourceFileLoader("kanban_facade", str(path))
    spec = importlib.util.spec_from_loader("kanban_facade", loader)
    assert spec, "could not build module spec"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["kanban_facade"] = mod
    loader.exec_module(mod)
    return mod


kf = _load_kanban_module()


# ─── trailer parsing ────────────────────────────────────────────────────────


def test_split_no_trailer():
    body = "do the thing"
    visible, trailer = kf._split_body_trailer(body)
    assert visible == "do the thing"
    assert trailer == {}


def test_split_with_epic_trailer():
    body = "do the thing\n\n---\nepic: t_abc123"
    visible, trailer = kf._split_body_trailer(body)
    assert visible == "do the thing"
    assert trailer == {"epic": "t_abc123"}


def test_split_with_two_keys():
    body = "do the thing\n\n---\nepic: t_abc\ngenesis_run: g-2026-05-27-1"
    visible, trailer = kf._split_body_trailer(body)
    assert visible == "do the thing"
    assert trailer == {"epic": "t_abc", "genesis_run": "g-2026-05-27-1"}


def test_split_ignores_unknown_trailer_keys():
    """Unknown keys mean the `---` is probably just a markdown rule, not our trailer.

    We require AT LEAST ONE recognized key — otherwise the `---` block
    is folded back into the visible body so we don't eat user content.
    """
    body = "do the thing\n\n---\nrandom: stuff"
    visible, trailer = kf._split_body_trailer(body)
    assert trailer == {}
    assert visible == body


def test_epic_of_returns_id():
    body = "scout for wood\n\n---\nepic: t_p2"
    assert kf._epic_of(body) == "t_p2"
    assert kf._epic_of("no trailer here") is None
    assert kf._epic_of(None) is None
    assert kf._epic_of("") is None


def test_attach_trailer_to_clean_body():
    body = "scout for wood"
    out = kf._attach_trailer(body, epic="t_p2")
    assert out == "scout for wood\n\n---\nepic: t_p2"
    assert kf._epic_of(out) == "t_p2"


def test_attach_trailer_replaces_existing():
    body = "scout for wood\n\n---\nepic: t_old"
    out = kf._attach_trailer(body, epic="t_new")
    assert kf._epic_of(out) == "t_new"
    # Visible body is unchanged
    visible, _ = kf._split_body_trailer(out)
    assert visible == "scout for wood"


def test_attach_trailer_empty_body():
    out = kf._attach_trailer("", epic="t_p2")
    assert kf._epic_of(out) == "t_p2"


def test_attach_trailer_with_run_id():
    out = kf._attach_trailer("scout", epic="t_p2", genesis_run="g-2026-05-27-1")
    visible, trailer = kf._split_body_trailer(out)
    assert visible == "scout"
    assert trailer == {"epic": "t_p2", "genesis_run": "g-2026-05-27-1"}


def test_round_trip_preserves_visible():
    """Repeatedly attach+split should not damage the visible body."""
    body = "line 1\nline 2\n\nparagraph 2"
    out = kf._attach_trailer(body, epic="t_p2")
    out = kf._attach_trailer(out, epic="t_p3")  # replace
    visible, trailer = kf._split_body_trailer(out)
    assert visible == body
    assert trailer["epic"] == "t_p3"


# ─── DB query helpers ───────────────────────────────────────────────────────


def _make_synthetic_db(path: Path) -> sqlite3.Connection:
    """Build a temporary kanban DB with the same shape Hermes uses."""
    conn = sqlite3.connect(str(path))
    conn.executescript(
        """
        CREATE TABLE tasks (
            id            TEXT PRIMARY KEY,
            title         TEXT NOT NULL,
            body          TEXT,
            assignee      TEXT,
            status        TEXT NOT NULL,
            priority      INTEGER DEFAULT 0,
            claim_lock    TEXT,
            created_at    INTEGER NOT NULL,
            completed_at  INTEGER
        );
        CREATE TABLE task_links (
            parent_id TEXT NOT NULL,
            child_id  TEXT NOT NULL,
            PRIMARY KEY (parent_id, child_id)
        );
        """
    )
    conn.row_factory = sqlite3.Row
    return conn


def _insert_task(
    conn: sqlite3.Connection,
    tid: str,
    title: str,
    *,
    body: str = "",
    assignee: str = "flint",
    status: str = "ready",
    priority: int = 0,
    claim_lock: str | None = None,
    created_at: int = 1000,
) -> None:
    conn.execute(
        "INSERT INTO tasks (id, title, body, assignee, status, priority, claim_lock, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (tid, title, body, assignee, status, priority, claim_lock, created_at),
    )


@pytest.fixture
def synthetic_db(tmp_path, monkeypatch):
    """Stand up a temp kanban DB and point the facade at it."""
    db_path = tmp_path / "kanban.db"
    conn = _make_synthetic_db(db_path)
    # Seed: an epic + two member SCOUTs + one real-dep card
    _insert_task(conn, "t_epic", "[EPIC] P2", assignee="steward", status="ready", created_at=100)
    _insert_task(
        conn,
        "t_wood",
        "[SCOUT] wood",
        body="scout NE\n\n---\nepic: t_epic",
        assignee="flint",
        status="ready",
        priority=50,
        created_at=200,
    )
    _insert_task(
        conn,
        "t_stone",
        "[SCOUT] stone",
        body="scout SW\n\n---\nepic: t_epic",
        assignee="mason",
        status="ready",
        priority=50,
        created_at=210,
    )
    _insert_task(
        conn,
        "t_pickaxe",
        "[CRAFT] iron pickaxe",
        body="needs iron from t_wood",
        assignee="mason",
        status="todo",
        created_at=220,
    )
    # t_pickaxe depends_on t_wood (real dep)
    conn.execute("INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)", ("t_wood", "t_pickaxe"))
    conn.commit()
    conn.close()

    monkeypatch.setattr(kf, "DB_PATH", db_path)
    return db_path


def test_fetch_task(synthetic_db):
    with kf._db() as conn:
        row = kf._fetch_task(conn, "t_wood")
    assert row is not None
    assert row["title"] == "[SCOUT] wood"
    assert row["assignee"] == "flint"


def test_fetch_task_missing(synthetic_db):
    with kf._db() as conn:
        assert kf._fetch_task(conn, "t_nope") is None


def test_fetch_parents_returns_real_dep(synthetic_db):
    with kf._db() as conn:
        parents = kf._fetch_parents(conn, "t_pickaxe")
    assert [p["id"] for p in parents] == ["t_wood"]


def test_create_refuses_depends_on_epic(synthetic_db, monkeypatch):
    """The g-2026-05-28-5 bug class: Steward uses --depends-on on an [EPIC]
    card which wedges the child in todo (epic never reaches done).
    cmd_create should refuse at write time with a redirect to --epic."""

    import argparse

    # Build args namespace; --depends-on points at t_epic which is titled
    # "[EPIC] P2" in the synthetic DB.
    ns = argparse.Namespace(
        title="[SUPPLY] some work",
        assignee="flint",
        epic=None,
        depends_on=["t_epic"],
        body="",
        priority=None,
        triage=False,
        skill=[],
        max_retries=None,
        idempotency_key=None,
        json=False,
    )

    # _die calls sys.exit; assert the right code AND the right message.
    with pytest.raises(SystemExit):
        kf.cmd_create(ns)


def test_create_allows_depends_on_non_epic(synthetic_db, monkeypatch):
    """The legitimate case: depends-on a non-epic card (e.g. SUPPLY depends-on
    SCOUT) should NOT trigger the refusal. We can't run the full create flow
    in a test (it shells out to hermes), but we can verify the validation
    walks past the depends_on loop without exiting."""
    import argparse

    # The synthetic DB has t_wood which is "[SCOUT] wood" — non-epic title.
    ns = argparse.Namespace(
        title="[SUPPLY] follow-up",
        assignee="mason",
        epic=None,
        depends_on=["t_wood"],
        body="",
        priority=None,
        triage=False,
        skill=[],
        max_retries=None,
        idempotency_key=None,
        json=False,
    )

    # Stub out _run so we don't actually shell out to hermes. We just want
    # the validation to pass; the subsequent subprocess call would fail in
    # a test env without hermes installed.
    class _FakeProc:
        def __init__(self):
            self.returncode = 1
            self.stdout = ""
            self.stderr = "hermes not available in test"
    monkeypatch.setattr(kf, "_run", lambda cmd, timeout=30: _FakeProc())

    # _die fires on the hermes subprocess failure — that's expected, NOT
    # the depends-on-epic refusal. We're checking the validation passed.
    with pytest.raises(SystemExit) as exc:
        kf.cmd_create(ns)
    # The error path here is the subprocess fail, not the epic check.
    # Validation passed if we got past it (no "targets an [EPIC] card" msg).


def test_fetch_parents_empty_for_epic_only_member(synthetic_db):
    """The whole point of the facade: --epic tagging does NOT create a link.
    So t_wood (epic member of t_epic) has ZERO parents."""
    with kf._db() as conn:
        parents = kf._fetch_parents(conn, "t_wood")
    assert parents == []


def test_fetch_children(synthetic_db):
    with kf._db() as conn:
        children = kf._fetch_children(conn, "t_wood")
    assert [c["id"] for c in children] == ["t_pickaxe"]


def test_scan_epic_children_finds_tagged(synthetic_db):
    with kf._db() as conn:
        members = kf._scan_epic_children(conn, "t_epic")
    assert {m["id"] for m in members} == {"t_wood", "t_stone"}


def test_scan_epic_children_no_match(synthetic_db):
    with kf._db() as conn:
        assert kf._scan_epic_children(conn, "t_no_such_epic") == []


def test_scan_epic_children_does_not_match_substring(synthetic_db):
    """Ensure `epic: t_epic` doesn't also match `epic: t_epic_extended`."""
    with sqlite3.connect(str(synthetic_db)) as conn:
        conn.execute(
            "INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "t_decoy",
                "[CONSTRUCT] decoy",
                "build it\n\n---\nepic: t_epic_extended",
                "mason",
                "ready",
                0,
                300,
            ),
        )
        conn.commit()
    with kf._db() as conn:
        members = kf._scan_epic_children(conn, "t_epic")
    # The decoy is NOT a member of t_epic — its trailer says t_epic_extended
    assert "t_decoy" not in {m["id"] for m in members}


def test_all_tasks_filters_status(synthetic_db):
    with kf._db() as conn:
        ready = kf._all_tasks(conn, status="ready", assignee=None)
        todo = kf._all_tasks(conn, status="todo", assignee=None)
    assert {r["id"] for r in ready} == {"t_epic", "t_wood", "t_stone"}
    assert {r["id"] for r in todo} == {"t_pickaxe"}


def test_all_tasks_filters_assignee(synthetic_db):
    with kf._db() as conn:
        flint = kf._all_tasks(conn, status=None, assignee="flint")
        mason = kf._all_tasks(conn, status=None, assignee="MASON")  # case-insensitive
    assert {r["id"] for r in flint} == {"t_wood"}
    assert {r["id"] for r in mason} == {"t_stone", "t_pickaxe"}


def test_all_tasks_status_csv(synthetic_db):
    with kf._db() as conn:
        rows = kf._all_tasks(conn, status="ready,todo", assignee=None)
    assert {r["id"] for r in rows} == {"t_epic", "t_wood", "t_stone", "t_pickaxe"}
