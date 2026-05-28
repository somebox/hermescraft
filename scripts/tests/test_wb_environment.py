"""Tests for scripts/wb — worker board proxy.

Covers:
- ``context`` resolves the active card via HERMES_KANBAN_TASK, surfaces
  the epic, and exposes siblings with title+status only (no bodies).
- ``--task`` overrides HERMES_KANBAN_TASK.
- Missing card id and unknown card id give clear errors.
- Write verbs (comment/close/block/escalate) shell out to ``hermes
  kanban …`` with the right argv. ``escalate`` prefixes the reason with
  ``[!ESCALATED] ``.
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
WB_PATH = REPO / "scripts" / "wb"
MIGRATION_PATH = REPO / "scripts" / "migrations" / "add_card_meta_cols.py"


def _load_module(name: str, path: Path):
    # `wb` has no .py extension; SourceFileLoader handles that, where
    # spec_from_file_location returns None for unknown suffixes.
    loader = SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def _make_board(tmp_path: Path) -> Path:
    """Build a kanban DB the way `hermes_cli.kanban_db.connect` would, then
    apply the P0 migration so location/size columns exist."""
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
            started_at   INTEGER
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
        """
    )
    # Seed an epic + two children. Child A is the one the worker is on.
    rows = [
        ("t_epic0001", "[EPIC] Build hut1", "epic body line one\nepic body line two", "steward", "ready", 1_700_000_000),
        ("t_card0001", "[SUPPLY] Wood for hut1", "gather 32 oak", "flint",   "running", 1_700_000_100),
        ("t_card0002", "[SCOUT] Anchor pad",     "find flat ground",          "mason",   "ready",   1_700_000_200),
    ]
    conn.executemany(
        "INSERT INTO tasks (id, title, body, assignee, status, priority, created_at) "
        "VALUES (?, ?, ?, ?, ?, 0, ?)",
        rows,
    )
    # Wire children under the epic via task_links.
    conn.executemany(
        "INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)",
        [("t_epic0001", "t_card0001"), ("t_epic0001", "t_card0002")],
    )
    # Seed one prior comment on the active card.
    conn.execute(
        "INSERT INTO task_comments (task_id, author, body, created_at) "
        "VALUES (?, ?, ?, ?)",
        ("t_card0001", "steward", "split into S chunks if you can", 1_700_000_150),
    )
    conn.commit()
    conn.close()

    # Apply P0 migration so the wb DB query (which selects location_*/size)
    # finds those columns.
    mig = _load_module("add_card_meta_cols", MIGRATION_PATH)
    mig.migrate(db)
    return db


@pytest.fixture()
def board_env(tmp_path, monkeypatch):
    db = _make_board(tmp_path)
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db))
    monkeypatch.setenv("HERMES_KANBAN_BOARD", "landfolk-ops")
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    # wb is a script — import it as a module so we can call its
    # functions directly and patch subprocess.run.
    sys.modules.pop("wb", None)
    wb = _load_module("wb", WB_PATH)
    # The module captures DB_PATH at import. Force it to the fixture DB.
    wb.DB_PATH = db
    return wb


# ─── context ──────────────────────────────────────────────────────────────


def test_context_uses_HERMES_KANBAN_TASK(board_env, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card0001")
    # Don't try to fetch bot pose during tests — return None deterministically.
    monkeypatch.setattr(board_env, "_fetch_bot_pose", lambda timeout=1.0: None)
    rc = board_env.main(["context"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "t_card0001" in out
    assert "[SUPPLY] Wood for hut1" in out
    assert "gather 32 oak" in out
    # Epic surfaced
    assert "t_epic0001" in out
    # Sibling title visible
    assert "[SCOUT] Anchor pad" in out
    # Sibling BODY is NOT visible (scope lock)
    assert "find flat ground" not in out
    # Comment preview shows the steward comment
    assert "split into S chunks" in out


def test_context_task_flag_overrides_env(board_env, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card0001")
    monkeypatch.setattr(board_env, "_fetch_bot_pose", lambda timeout=1.0: None)
    rc = board_env.main(["--task", "t_card0002", "context"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "t_card0002" in out
    assert "[SCOUT] Anchor pad" in out


def test_context_missing_active_task_fails_clearly(board_env, capsys):
    with pytest.raises(SystemExit) as excinfo:
        board_env.main(["context"])
    assert excinfo.value.code != 0
    err = capsys.readouterr().err
    assert "HERMES_KANBAN_TASK" in err


def test_context_unknown_card_fails_clearly(board_env, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_notexist")
    monkeypatch.setattr(board_env, "_fetch_bot_pose", lambda timeout=1.0: None)
    with pytest.raises(SystemExit) as excinfo:
        board_env.main(["context"])
    assert excinfo.value.code != 0
    err = capsys.readouterr().err
    assert "no card t_notexist" in err


def test_context_json_output(board_env, monkeypatch, capsys):
    import json as _json
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card0001")
    monkeypatch.setattr(board_env, "_fetch_bot_pose", lambda timeout=1.0: None)
    rc = board_env.main(["context", "--json"])
    assert rc == 0
    data = _json.loads(capsys.readouterr().out)
    assert data["card"]["id"] == "t_card0001"
    assert data["epic"]["id"] == "t_epic0001"
    assert {s["id"] for s in data["siblings"]} == {"t_card0002"}
    # Bodies never leak via sibling JSON either
    assert "body" not in data["siblings"][0]


# ─── write verbs ──────────────────────────────────────────────────────────


class _Recorder:
    def __init__(self):
        self.calls: list[list[str]] = []

    def __call__(self, cmd, *args, **kwargs):
        import subprocess as _sp
        self.calls.append(list(cmd))
        return _sp.CompletedProcess(args=cmd, returncode=0, stdout="", stderr="")


def _patch_hermes(monkeypatch, board_env):
    rec = _Recorder()
    monkeypatch.setattr(board_env, "_run", rec)
    monkeypatch.setattr(board_env.shutil, "which", lambda _: "/usr/local/bin/hermes")
    return rec


def test_comment_invokes_hermes_kanban(board_env, monkeypatch, capsys):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card0001")
    rec = _patch_hermes(monkeypatch, board_env)
    rc = board_env.main(["comment", "checking inventory"])
    assert rc == 0
    assert rec.calls == [[
        "hermes", "kanban", "--board", "landfolk-ops",
        "comment", "t_card0001", "checking inventory",
    ]]


def test_close_with_result(board_env, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card0001")
    rec = _patch_hermes(monkeypatch, board_env)
    rc = board_env.main(["close", "--result", "got 32 oak"])
    assert rc == 0
    assert rec.calls == [[
        "hermes", "kanban", "--board", "landfolk-ops",
        "complete", "t_card0001", "--result", "got 32 oak",
    ]]


def test_block_invokes_hermes_kanban(board_env, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card0001")
    rec = _patch_hermes(monkeypatch, board_env)
    rc = board_env.main(["block", "ran out of pickaxes"])
    assert rc == 0
    assert rec.calls == [[
        "hermes", "kanban", "--board", "landfolk-ops",
        "block", "t_card0001", "ran out of pickaxes",
    ]]


def test_escalate_prefixes_reason(board_env, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card0001")
    rec = _patch_hermes(monkeypatch, board_env)
    rc = board_env.main(["escalate", "ground is bedrock"])
    assert rc == 0
    # Reuses the `block` event, but prefixed so Steward's board view can
    # surface a NEEDS REVIEW lane without a schema change.
    assert rec.calls == [[
        "hermes", "kanban", "--board", "landfolk-ops",
        "block", "t_card0001", "[!ESCALATED] ground is bedrock",
    ]]


def test_write_verb_uses_explicit_task_flag(board_env, monkeypatch):
    rec = _patch_hermes(monkeypatch, board_env)
    rc = board_env.main(["--task", "t_card0002", "comment", "ack"])
    assert rc == 0
    assert rec.calls[0][5] == "t_card0002"
