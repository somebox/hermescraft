"""W2-NAV-004: agent-test session mc verb extraction."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

_spec = importlib.util.spec_from_file_location(
    "agent_test",
    ROOT / "scripts" / "agent-test.py",
)
agent_test = importlib.util.module_from_spec(_spec)
assert _spec.loader
sys.modules["agent_test"] = agent_test
_spec.loader.exec_module(agent_test)


def test_tool_calls_terminal_command():
    sess = {
        "messages": [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {
                            "name": "terminal",
                            "arguments": '{"command": "mc status && mc scene"}',
                        }
                    }
                ],
            }
        ]
    }
    tcs, verbs = agent_test.extract_session_mc_metrics(sess)
    assert len(tcs) == 1
    assert verbs == ["status", "scene"]


def test_tool_use_block_with_code_key():
    sess = {
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "terminal",
                        "input": {"code": "mc move 1 2 3"},
                    }
                ],
            }
        ]
    }
    _, verbs = agent_test.extract_session_mc_metrics(sess)
    assert verbs == ["move"]


def test_assistant_text_mc_lines():
    sess = {
        "messages": [
            {
                "role": "assistant",
                "content": "Running checks.\nmc status\nmc go_mark overlook\n",
            }
        ]
    }
    _, verbs = agent_test.extract_session_mc_metrics(sess)
    assert "status" in verbs
    assert "go_mark" in verbs


def test_state_db_fallback_loads_messages(tmp_path, monkeypatch):
    """W2-NAV-004 deeper fix: hermes >= 2026-06 writes per-profile state.db
    instead of session JSON. _load_session_from_state_db must scan profile
    state.db files, find the session_id, and return a dict the extractor reads."""
    import json
    import sqlite3

    fake_hermes_home = tmp_path / ".hermes" / "profiles" / "navigator"
    fake_hermes_home.mkdir(parents=True)
    db = fake_hermes_home / "state.db"
    conn = sqlite3.connect(db)
    conn.execute("""
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            role TEXT,
            tool_name TEXT,
            content TEXT,
            tool_calls TEXT,
            timestamp REAL,
            reasoning TEXT
        )
    """)
    sid = "20260609_011450_dcb35c"
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?,?,?,?)",
        (sid, "assistant", json.dumps([{"type": "text", "text": "Calling mc."}]),
         json.dumps([{
             "function": {"name": "terminal",
                          "arguments": '{"command": "mc status"}'}}])),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?,?,?,?)",
        (sid, "assistant", json.dumps([{
            "type": "tool_use", "name": "terminal",
            "input": {"command": "mc go_mark overlook"}}]),
         "[]"),
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    sess = agent_test._load_session_from_state_db(sid)
    assert sess is not None, "should find session row by id in profile state.db"
    tcs, verbs = agent_test.extract_session_mc_metrics(sess)
    assert "status" in verbs
    assert "go_mark" in verbs


def test_state_db_returns_none_for_unknown_session(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / ".hermes").mkdir()
    assert agent_test._load_session_from_state_db("nope") is None
