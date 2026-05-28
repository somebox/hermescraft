"""Tests for scripts/kanban — action-oriented verbs + consolidated read views.

DB-direct verbs (promote / set-priority / edit / add / board / card) run
against a tmp sqlite. Shell-out verbs (set-after / unset-after / resolve
/ assign / add-epic) are tested by monkey-patching the ``_run`` helper
and asserting the recorded argv.
"""
from __future__ import annotations

import importlib.util
import json
import sqlite3
import subprocess
import sys
import time
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
KANBAN_PATH = REPO / "scripts" / "kanban"
MIGRATION_PATH = REPO / "scripts" / "migrations" / "add_card_meta_cols.py"


def _load_module(name: str, path: Path):
    loader = SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def _seed_board(tmp_path: Path) -> Path:
    """Build a kanban DB matching upstream's tasks/links/comments/events shape
    plus the P0 card-meta columns."""
    db = tmp_path / "kanban.db"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        """
        CREATE TABLE tasks (
            id           TEXT PRIMARY KEY,
            title        TEXT NOT NULL,
            body         TEXT,
            assignee     TEXT,
            status       TEXT NOT NULL,
            priority     INTEGER DEFAULT 0,
            created_at   INTEGER NOT NULL,
            started_at   INTEGER,
            completed_at INTEGER,
            claim_lock   TEXT
        );
        CREATE TABLE task_links (
            parent_id TEXT NOT NULL,
            child_id  TEXT NOT NULL,
            PRIMARY KEY (parent_id, child_id)
        );
        CREATE TABLE task_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE task_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT,
            created_at INTEGER NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()
    mig = _load_module("add_card_meta_cols", MIGRATION_PATH)
    mig.migrate(db)
    return db


@pytest.fixture()
def env(tmp_path, monkeypatch):
    db = _seed_board(tmp_path)
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db))
    monkeypatch.setenv("HERMES_KANBAN_BOARD", "landfolk-ops")
    sys.modules.pop("kanban_facade", None)
    k = _load_module("kanban_facade", KANBAN_PATH)
    k.DB_PATH = db
    # Pretend `hermes` is on PATH so main() doesn't bail.
    monkeypatch.setattr(k.shutil, "which", lambda _: "/usr/local/bin/hermes")
    return k


class _Recorder:
    """Stand-in for kanban._run.

    Records argv and returns success. When the command is `hermes kanban
    … create … --json`, mints a fresh task id, **also INSERTs a stub row
    into the test DB** (so follow-up DB-direct UPDATEs target a real
    row), and returns `{"id": …}` JSON.
    """
    def __init__(self, db_path: Path):
        self.calls: list[list[str]] = []
        self._next_id = 0
        self._db_path = db_path

    def _new_id(self) -> str:
        self._next_id += 1
        return f"t_seed{self._next_id:04d}"

    def __call__(self, cmd, *args, **kwargs):
        self.calls.append(list(cmd))
        if "create" in cmd and "--json" in cmd:
            tid = self._new_id()
            # Extract the title + body so the stub row looks realistic.
            try:
                title = cmd[cmd.index("create") + 1]
            except (ValueError, IndexError):
                title = "stub"
            body = ""
            if "--body" in cmd:
                body = cmd[cmd.index("--body") + 1]
            assignee = None
            if "--assignee" in cmd:
                assignee = cmd[cmd.index("--assignee") + 1]
            with sqlite3.connect(str(self._db_path)) as conn:
                conn.execute(
                    "INSERT INTO tasks (id, title, body, assignee, status, "
                    "priority, created_at) VALUES (?, ?, ?, ?, 'ready', 0, ?)",
                    (tid, title, body, assignee, int(time.time())),
                )
            payload = json.dumps({"id": tid})
            return subprocess.CompletedProcess(args=cmd, returncode=0,
                                               stdout=payload, stderr="")
        return subprocess.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")


def _patch_run(monkeypatch, env) -> _Recorder:
    rec = _Recorder(env.DB_PATH)
    monkeypatch.setattr(env, "_run", rec)
    return rec


def _row(env, tid: str):
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()


def _insert_task(env, **kw):
    defaults = dict(title="x", body="", assignee="flint", status="todo",
                    priority=0, created_at=int(time.time()), started_at=None,
                    completed_at=None, claim_lock=None,
                    location_x=None, location_y=None, location_z=None, size=None)
    defaults.update(kw)
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        conn.execute(
            "INSERT INTO tasks (id, title, body, assignee, status, priority, "
            "created_at, started_at, completed_at, claim_lock, "
            "location_x, location_y, location_z, size) "
            "VALUES (:id, :title, :body, :assignee, :status, :priority, "
            ":created_at, :started_at, :completed_at, :claim_lock, "
            ":location_x, :location_y, :location_z, :size)",
            defaults,
        )


# ─── add / add-epic ───────────────────────────────────────────────────────


def test_add_epic_prefixes_title_and_calls_create(env, monkeypatch, capsys):
    rec = _patch_run(monkeypatch, env)
    rc = env.main(["add-epic", "Defenses and watchtower"])
    assert rc == 0
    create_call = rec.calls[0]
    title_idx = create_call.index("create") + 1
    assert create_call[title_idx] == "[EPIC] Defenses and watchtower"
    assert "--assignee" in create_call


def test_add_default_size_is_M(env, monkeypatch, capsys):
    rec = _patch_run(monkeypatch, env)
    rc = env.main(["add", "Wood haul", "--assignee", "flint"])
    assert rc == 0
    err = capsys.readouterr().err
    assert "size defaulted to M" in err
    # The newly-created card should have size=M in the DB.
    tid = rec._new_id  # next id minted; but we used _new_id once for create
    # Find the actual id from the create call's response — easier: query.
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT id, size FROM tasks").fetchall()
    assert len(rows) == 1
    assert rows[0]["size"] == "M"


def test_add_with_for_and_after_and_location(env, monkeypatch):
    rec = _patch_run(monkeypatch, env)
    # Seed an epic + a prereq the new card will reference.
    _insert_task(env, id="t_epic0001", title="[EPIC] Foo", status="ready")
    _insert_task(env, id="t_prereq01", title="[SCOUT] x", status="done")
    rc = env.main([
        "add", "Wood haul",
        "--assignee", "flint",
        "--for", "t_epic0001",
        "--after", "t_prereq01",
        "--size", "S",
        "--at", "372,64,-595",
    ])
    assert rc == 0
    # First call = create with the body including epic trailer.
    create = rec.calls[0]
    assert "create" in create
    body_idx = create.index("--body") + 1
    assert "epic: t_epic0001" in create[body_idx]
    # Second call = link parent → child (after wiring).
    assert any(c[2:4] == ["--board", "landfolk-ops"] and c[4] == "link" for c in rec.calls)
    # The new card has size + location persisted.
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT size, location_x, location_y, location_z FROM tasks "
            "WHERE id LIKE 't_seed%'"
        ).fetchone()
    assert row["size"] == "S"
    assert row["location_x"] == 372
    assert row["location_y"] == 64
    assert row["location_z"] == -595


def test_add_after_against_epic_is_rejected(env, monkeypatch):
    _patch_run(monkeypatch, env)
    _insert_task(env, id="t_epic0001", title="[EPIC] Foo", status="ready")
    with pytest.raises(SystemExit):
        env.main(["add", "x", "--assignee", "flint", "--after", "t_epic0001"])


def test_add_invalid_size_rejected(env, monkeypatch):
    _patch_run(monkeypatch, env)
    with pytest.raises(SystemExit):
        env.main(["add", "x", "--assignee", "flint", "--size", "huge"])


# ─── promote ──────────────────────────────────────────────────────────────


def test_promote_todo_to_ready(env):
    _insert_task(env, id="t_card0001", title="x", status="todo")
    rc = env.main(["promote", "t_card0001"])
    assert rc == 0
    assert _row(env, "t_card0001")["status"] == "ready"
    # Event row written.
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        kinds = [r[0] for r in conn.execute(
            "SELECT kind FROM task_events WHERE task_id = ?", ("t_card0001",))]
    assert "promoted" in kinds


def test_promote_with_undone_parent_blocks_without_force(env):
    _insert_task(env, id="t_parent01", title="parent", status="ready")
    _insert_task(env, id="t_card0001", title="x", status="todo")
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        conn.execute("INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)",
                     ("t_parent01", "t_card0001"))
    with pytest.raises(SystemExit):
        env.main(["promote", "t_card0001"])
    assert _row(env, "t_card0001")["status"] == "todo"


def test_promote_with_undone_parent_succeeds_with_force(env):
    _insert_task(env, id="t_parent01", title="parent", status="ready")
    _insert_task(env, id="t_card0001", title="x", status="todo")
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        conn.execute("INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)",
                     ("t_parent01", "t_card0001"))
    rc = env.main(["promote", "t_card0001", "--force"])
    assert rc == 0
    assert _row(env, "t_card0001")["status"] == "ready"


# ─── resolve ──────────────────────────────────────────────────────────────


def test_resolve_unblocks_and_comments(env, monkeypatch):
    rec = _patch_run(monkeypatch, env)
    rc = env.main(["resolve", "t_anycard", "reassigned to mason"])
    assert rc == 0
    assert rec.calls[0][4] == "unblock"
    assert rec.calls[1][4] == "comment"
    assert rec.calls[1][6].startswith("[RESOLVED] ")
    assert "reassigned to mason" in rec.calls[1][6]


# ─── set-priority ─────────────────────────────────────────────────────────


def test_set_priority(env):
    _insert_task(env, id="t_card0001", title="x", priority=5)
    rc = env.main(["set-priority", "t_card0001", "20"])
    assert rc == 0
    assert _row(env, "t_card0001")["priority"] == 20
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        ev = conn.execute(
            "SELECT payload FROM task_events WHERE task_id = ? AND kind = 'reprioritized'",
            ("t_card0001",)).fetchone()
    assert ev is not None
    assert json.loads(ev[0]) == {"from": 5, "to": 20}


# ─── set-after / unset-after ──────────────────────────────────────────────


def test_set_after_calls_link(env, monkeypatch):
    rec = _patch_run(monkeypatch, env)
    rc = env.main(["set-after", "t_child", "t_parent"])
    assert rc == 0
    assert rec.calls[0][4:7] == ["link", "t_parent", "t_child"]


def test_unset_after_calls_unlink(env, monkeypatch):
    rec = _patch_run(monkeypatch, env)
    rc = env.main(["unset-after", "t_child", "t_parent"])
    assert rc == 0
    assert rec.calls[0][4:7] == ["unlink", "t_parent", "t_child"]


# ─── edit ─────────────────────────────────────────────────────────────────


def test_edit_updates_multiple_fields(env):
    _insert_task(env, id="t_card0001", title="old", body="ob", status="ready", priority=0)
    rc = env.main([
        "edit", "t_card0001",
        "--title", "new title",
        "--size", "L",
        "--at", "10,20,30",
        "--priority", "7",
    ])
    assert rc == 0
    row = _row(env, "t_card0001")
    assert row["title"] == "new title"
    assert row["size"] == "L"
    assert row["location_x"] == 10
    assert row["location_y"] == 20
    assert row["location_z"] == 30
    assert row["priority"] == 7


def test_edit_refuses_completed_card(env):
    _insert_task(env, id="t_card0001", title="x", status="done")
    with pytest.raises(SystemExit):
        env.main(["edit", "t_card0001", "--title", "won't apply"])


def test_edit_needs_at_least_one_change(env):
    _insert_task(env, id="t_card0001", title="x", status="ready")
    with pytest.raises(SystemExit):
        env.main(["edit", "t_card0001"])


# ─── assign ──────────────────────────────────────────────────────────────


def test_assign_calls_upstream_assign(env, monkeypatch):
    rec = _patch_run(monkeypatch, env)
    rc = env.main(["assign", "t_card0001", "mason"])
    assert rc == 0
    assert rec.calls[0][4] == "assign"
    assert rec.calls[0][5:7] == ["t_card0001", "mason"]


# ─── board (read view) ────────────────────────────────────────────────────


def test_board_sections_render(env, monkeypatch, capsys):
    now = int(time.time())
    _insert_task(env, id="t_run01", title="[SUPPLY] Wood", status="running",
                 assignee="flint", started_at=now - 600, size="M")
    _insert_task(env, id="t_rd01", title="[SCOUT] Site", status="ready",
                 assignee="mason", size="S", priority=10)
    _insert_task(env, id="t_blk01", title="[BUG] Wedged", status="blocked",
                 assignee="flint")
    _insert_task(env, id="t_esc01", title="[SUPPLY] Cobble", status="blocked",
                 assignee="flint")
    # Wire an [!ESCALATED] block event so t_esc01 surfaces as NEEDS REVIEW.
    with sqlite3.connect(str(env.DB_PATH)) as conn:
        conn.execute(
            "INSERT INTO task_events (task_id, kind, payload, created_at) "
            "VALUES (?, 'blocked', ?, ?)",
            ("t_esc01",
             json.dumps({"reason": "[!ESCALATED] bedrock everywhere"}),
             now),
        )
        conn.execute(
            "INSERT INTO task_events (task_id, kind, payload, created_at) "
            "VALUES (?, 'blocked', ?, ?)",
            ("t_blk01",
             json.dumps({"reason": "ran out of pickaxes"}),
             now),
        )
    _insert_task(env, id="t_epic01", title="[EPIC] Hut", status="ready",
                 assignee="steward")
    _insert_task(env, id="t_epic01_child", title="x", status="done",
                 body="---\nepic: t_epic01")
    rc = env.main(["board"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "IN-FLIGHT (1)" in out
    assert "t_run01" in out
    assert "READY (1)" in out
    assert "t_rd01" in out
    assert "NEEDS REVIEW (1)" in out
    assert "t_esc01" in out
    assert "bedrock everywhere" in out
    assert "BLOCKED (1)" in out
    assert "ran out of pickaxes" in out
    assert "EPICS OPEN (1)" in out
    assert "1/1 done" in out


def test_board_json(env, capsys):
    _insert_task(env, id="t_rd01", title="[SCOUT] x", status="ready", assignee="mason")
    rc = env.main(["board", "--json"])
    assert rc == 0
    data = json.loads(capsys.readouterr().out)
    assert data["board"] == "landfolk-ops"
    assert data["ready"][0]["id"] == "t_rd01"
    assert "epics_open" in data
    assert "recent" in data


# ─── card (read view) ────────────────────────────────────────────────────


def test_card_view_shows_location_and_size(env, capsys):
    _insert_task(env, id="t_card0001", title="x", status="ready",
                 size="L", location_x=1, location_y=2, location_z=3)
    rc = env.main(["card", "t_card0001"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "size: L" in out
    assert "location: 1,2,3" in out
