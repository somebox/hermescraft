"""End-to-end lifecycle smoke test for the worker-board-proxy redesign.

Walks one card through every seam between scripts/kanban (Steward) and
scripts/wb (worker):

    add-epic → add → wb context → wb comment → wb escalate →
    kanban board (verify NEEDS REVIEW) → kanban resolve → wb close →
    kanban card (verify done)

The hermes CLI is replaced with a recorder that mutates the test DB the
same way `hermes kanban` would (create/comment/complete/block/unblock/
link/assign). This isolates the test from a real Hermes installation
and keeps it deterministic.
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
WB_PATH = REPO / "scripts" / "wb"
MIGRATION_PATH = REPO / "scripts" / "migrations" / "add_card_meta_cols.py"


def _load(name: str, path: Path):
    loader = SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def _seed(tmp_path: Path) -> Path:
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
    mig = _load("add_card_meta_cols", MIGRATION_PATH)
    mig.migrate(db)
    return db


class _HermesStub:
    """Recorder that mutates the test DB the way real `hermes kanban` would.

    Covers the subset our two CLIs invoke: create, comment, complete,
    block, unblock, link, assign. Each handler matches the upstream
    semantics closely enough for the smoke test to be meaningful
    without requiring a Hermes installation.
    """
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.calls: list[list[str]] = []
        self._next_id = 0

    def _mint_id(self) -> str:
        self._next_id += 1
        return f"t_smk{self._next_id:05d}"

    def _conn(self):
        c = sqlite3.connect(str(self.db_path), isolation_level=None, timeout=5)
        c.row_factory = sqlite3.Row
        return c

    def _write_event(self, conn, task_id, kind, payload=None):
        conn.execute(
            "INSERT INTO task_events (task_id, kind, payload, created_at) "
            "VALUES (?, ?, ?, ?)",
            (task_id, kind, json.dumps(payload) if payload else None,
             int(time.time())),
        )

    def __call__(self, cmd, *args, **kwargs):
        self.calls.append(list(cmd))
        # All commands have shape: hermes kanban --board <slug> <verb> <args...>
        if len(cmd) < 5 or cmd[0] != "hermes" or cmd[1] != "kanban":
            return subprocess.CompletedProcess(args=cmd, returncode=0,
                                               stdout="", stderr="")
        verb = cmd[4]
        rest = list(cmd[5:])
        json_out = "--json" in rest
        if json_out:
            rest = [a for a in rest if a != "--json"]
        handler = getattr(self, f"_h_{verb.replace('-', '_')}", None)
        if handler is None:
            return subprocess.CompletedProcess(args=cmd, returncode=0,
                                               stdout="", stderr="")
        out, rc = handler(rest, json_out=json_out)
        return subprocess.CompletedProcess(args=cmd, returncode=rc,
                                           stdout=out, stderr="")

    def _h_create(self, rest, json_out):
        title = rest[0]
        flags = {}
        i = 1
        while i < len(rest):
            if rest[i] in ("--body", "--assignee", "--priority"):
                flags[rest[i]] = rest[i + 1]
                i += 2
            else:
                i += 1
        tid = self._mint_id()
        with self._conn() as c:
            c.execute(
                "INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) "
                "VALUES (?, ?, ?, ?, 'ready', ?, ?)",
                (tid, title, flags.get("--body", ""), flags.get("--assignee"),
                 int(flags.get("--priority", 0) or 0), int(time.time())),
            )
            self._write_event(c, tid, "created",
                              {"assignee": flags.get("--assignee")})
        return (json.dumps({"id": tid}) if json_out else f"{tid}\n", 0)

    def _h_comment(self, rest, json_out):
        tid, body = rest[0], rest[1]
        with self._conn() as c:
            c.execute(
                "INSERT INTO task_comments (task_id, author, body, created_at) "
                "VALUES (?, 'steward', ?, ?)",
                (tid, body, int(time.time())),
            )
            self._write_event(c, tid, "comment_added", {"len": len(body)})
        return ("", 0)

    def _h_complete(self, rest, json_out):
        tid = rest[0]
        result = None
        if "--result" in rest:
            result = rest[rest.index("--result") + 1]
        with self._conn() as c:
            c.execute(
                "UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?",
                (int(time.time()), tid),
            )
            self._write_event(c, tid, "completed", {"result": result})
        return ("", 0)

    def _h_block(self, rest, json_out):
        tid = rest[0]
        reason = rest[1] if len(rest) > 1 else ""
        with self._conn() as c:
            c.execute("UPDATE tasks SET status = 'blocked' WHERE id = ?", (tid,))
            self._write_event(c, tid, "blocked", {"reason": reason})
        return ("", 0)

    def _h_unblock(self, rest, json_out):
        tid = rest[0]
        with self._conn() as c:
            c.execute("UPDATE tasks SET status = 'ready' WHERE id = ?", (tid,))
            self._write_event(c, tid, "unblocked")
        return ("", 0)

    def _h_link(self, rest, json_out):
        parent, child = rest[0], rest[1]
        with self._conn() as c:
            c.execute(
                "INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)",
                (parent, child),
            )
        return ("", 0)

    def _h_assign(self, rest, json_out):
        tid, assignee = rest[0], rest[1]
        with self._conn() as c:
            c.execute("UPDATE tasks SET assignee = ? WHERE id = ?", (assignee, tid))
            self._write_event(c, tid, "reassigned", {"assignee": assignee})
        return ("", 0)


@pytest.fixture()
def smoke(tmp_path, monkeypatch):
    db = _seed(tmp_path)
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db))
    monkeypatch.setenv("HERMES_KANBAN_BOARD", "landfolk-ops")
    sys.modules.pop("kanban_smoke", None)
    sys.modules.pop("wb_smoke", None)
    k = _load("kanban_smoke", KANBAN_PATH)
    w = _load("wb_smoke", WB_PATH)
    k.DB_PATH = db
    w.DB_PATH = db
    stub = _HermesStub(db)
    monkeypatch.setattr(k, "_run", stub)
    monkeypatch.setattr(w, "_run", stub)
    monkeypatch.setattr(k.shutil, "which", lambda _: "/usr/local/bin/hermes")
    monkeypatch.setattr(w.shutil, "which", lambda _: "/usr/local/bin/hermes")
    # Bot pose is unreachable in tests; force None so wb context doesn't 1-second-stall.
    monkeypatch.setattr(w, "_fetch_bot_pose", lambda timeout=1.0: None)
    return {"kanban": k, "wb": w, "stub": stub, "db": db}


def _query_one(db, sql, params=()):
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def _query_all(db, sql, params=()):
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    try:
        return list(conn.execute(sql, params))
    finally:
        conn.close()


def test_full_lifecycle(smoke, monkeypatch, capsys):
    k, w, stub, db = smoke["kanban"], smoke["wb"], smoke["stub"], smoke["db"]

    # 1. Steward files an epic for phase P3.
    rc = k.main(["add-epic", "Defenses and watch tower",
                 "--body", "shelter+tower", "--priority", "50"])
    assert rc == 0
    epic = _query_one(db, "SELECT id, title, status FROM tasks "
                          "WHERE title LIKE '%[EPIC]%'")
    assert epic is not None
    epic_id = epic["id"]
    assert epic["title"].startswith("[EPIC] ")

    # 2. Steward files a worker card under the epic with size + location.
    capsys.readouterr()  # reset
    rc = k.main(["add", "Gather wood from lt_wood_se",
                 "--assignee", "flint",
                 "--for", epic_id,
                 "--size", "M",
                 "--at", "372,64,-595"])
    assert rc == 0
    card = _query_one(db, "SELECT id, title, assignee, size, "
                          "location_x, location_y, location_z FROM tasks "
                          "WHERE id LIKE 't_smk%' AND assignee = 'flint'")
    assert card["size"] == "M"
    assert card["location_x"] == 372
    assert card["assignee"] == "flint"
    card_id = card["id"]

    # 3. Dispatcher fires the worker — wb sees the card via HERMES_KANBAN_TASK.
    monkeypatch.setenv("HERMES_KANBAN_TASK", card_id)
    capsys.readouterr()
    rc = w.main(["context"])
    assert rc == 0
    out = capsys.readouterr().out
    assert card_id in out
    assert "[EPIC] Defenses and watch tower" in out  # epic surfaces in context
    assert "372,64,-595" in out
    assert "size: M" in out

    # 4. Worker drops a progress comment.
    rc = w.main(["comment", "felling oaks at lt_wood_se now"])
    assert rc == 0
    comment = _query_one(db, "SELECT body, author FROM task_comments "
                             "WHERE task_id = ?", (card_id,))
    assert comment is not None
    assert "felling oaks" in comment["body"]

    # 5. Worker hits an obstacle and escalates.
    capsys.readouterr()
    rc = w.main(["escalate", "no oak trees within 64 blocks of lt_wood_se"])
    assert rc == 0
    row = _query_one(db, "SELECT status FROM tasks WHERE id = ?", (card_id,))
    assert row["status"] == "blocked"
    ev = _query_one(db, "SELECT payload FROM task_events WHERE task_id = ? "
                        "AND kind = 'blocked' ORDER BY created_at DESC LIMIT 1",
                    (card_id,))
    assert "[!ESCALATED]" in json.loads(ev["payload"])["reason"]

    # 6. Steward sees the card under NEEDS REVIEW.
    capsys.readouterr()
    rc = k.main(["board"])
    assert rc == 0
    board_out = capsys.readouterr().out
    assert "NEEDS REVIEW (1)" in board_out
    assert card_id in board_out

    # 7. Steward resolves the escalation with a note (reassigns to mason).
    rc = k.main(["resolve", card_id, "lt_wood_ne has oaks; switched site"])
    assert rc == 0
    row = _query_one(db, "SELECT status FROM tasks WHERE id = ?", (card_id,))
    assert row["status"] == "ready"
    # Use id DESC (monotonic AUTOINCREMENT) rather than created_at —
    # multiple comments often land within the same second-granular ts.
    audit = _query_one(db, "SELECT body FROM task_comments WHERE task_id = ? "
                           "ORDER BY id DESC LIMIT 1", (card_id,))
    assert audit["body"].startswith("[RESOLVED] ")

    # 8. Worker finishes the (now-revised) work.
    rc = w.main(["close", "--result", "32 oak in chest_supply"])
    assert rc == 0
    row = _query_one(db, "SELECT status, completed_at FROM tasks WHERE id = ?",
                     (card_id,))
    assert row["status"] == "done"
    assert row["completed_at"] is not None

    # 9. Card view shows the closed card with location + size preserved.
    capsys.readouterr()
    rc = k.main(["card", card_id])
    assert rc == 0
    card_out = capsys.readouterr().out
    assert "done" in card_out
    assert "size: M" in card_out
    assert "location: 372,64,-595" in card_out


def test_escalate_appears_in_board_json(smoke, monkeypatch):
    k, w, db = smoke["kanban"], smoke["wb"], smoke["db"]
    rc = k.main(["add-epic", "P4 ops"])
    assert rc == 0
    epic_id = _query_one(db, "SELECT id FROM tasks WHERE title LIKE '%[EPIC]%'")["id"]
    rc = k.main(["add", "[SCOUT] coal",
                 "--assignee", "mason", "--for", epic_id, "--size", "S"])
    assert rc == 0
    card_id = _query_one(db, "SELECT id FROM tasks WHERE assignee = 'mason'")["id"]
    monkeypatch.setenv("HERMES_KANBAN_TASK", card_id)
    rc = w.main(["escalate", "card body says lt_coal but the mark doesn't exist"])
    assert rc == 0
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = k.main(["board", "--json"])
    assert rc == 0
    data = json.loads(buf.getvalue())
    nr = data["needs_review"]
    assert len(nr) == 1
    assert nr[0]["id"] == card_id
    assert "lt_coal" in nr[0]["reason"]
