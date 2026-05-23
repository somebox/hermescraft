"""F46: `mc task` reports three slots — {task, sync, last}.

Migrated from scripts/test-task-semantics.py. F46 distinguishes async
in-flight, sync in-flight, and just-finished activity so the brain can
tell "I'm waiting on the bot" from "I last saw the bot finish X."

Scenarios:
  A: idle bot → task slot is null OR in terminal status, sync slot null.
  B: just-finished sync look → last.action='look', status='done', sync=null.
  C: slow sync move while polling → at least one snapshot shows
     sync.action='move'.
  D: async task started via /task/start → see status 'running' then 'done'.
"""

from __future__ import annotations

import threading
import time

import pytest


@pytest.fixture
def task_arena(rcon, arena, tester_bot, config):
    """Open grass arena; bot at (0,65,0). Cross-dim safe re-home first."""
    world = config["mc"]["world"]
    rcon.run(f"mvtp Tester {world}")
    time.sleep(0.5)
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")
    arena.settle_default()
    yield
    rcon.run(f"execute in {world} run tp Tester 0 65 0 0 0")


def _get_task(bot) -> dict:
    return bot.get("/task")


@pytest.mark.functional
def test_idle_bot_reports_null_sync_and_terminal_task(bot, task_arena):
    """A: cancel any leftover async then verify {sync=null, task in
    terminal state or null}. The bot keeps the previous task in
    `currentTask` as history — that's not 'running'."""
    try:
        bot.post("/task/cancel", {}, timeout=5)
    except Exception:
        pass
    time.sleep(0.5)
    data = (_get_task(bot).get("data") or {})
    task = data.get("task")
    sync = data.get("sync")
    task_status = (task or {}).get("status")
    assert sync is None, data
    assert task is None or task_status in {"done", "cancelled", "failed"}, data


@pytest.mark.functional
def test_sync_look_populates_last_status_done(bot, task_arena):
    """B: mc look (fast sync) → last.action='look', last.status='done',
    sync still null after the call returns."""
    bot.post("/action/look", {"x": 5, "y": 65, "z": 5}, timeout=5)
    data = (_get_task(bot).get("data") or {})
    last = data.get("last") or {}
    assert data.get("sync") is None, data
    assert last.get("action") == "look", last
    assert last.get("status") == "done", last


@pytest.mark.functional
def test_sync_move_in_flight_shows_in_sync_slot(bot, task_arena):
    """C: kick off a slow mc move; poll /task in a background thread. At
    least one snapshot must have sync.action='move'."""
    snapshots: list[dict] = []
    stop = threading.Event()

    def poll() -> None:
        while not stop.is_set():
            try:
                r = _get_task(bot)
                snapshots.append(r.get("data") or {})
            except Exception:
                pass
            time.sleep(0.05)

    t = threading.Thread(target=poll, daemon=True)
    t.start()
    bot.post("/action/move", {"x": 25, "y": 65, "z": 25, "max_doors": 0}, timeout=30)
    stop.set()
    t.join(timeout=2.0)

    saw_sync_move = any(
        (s.get("sync") or {}).get("action") == "move" for s in snapshots
    )
    assert saw_sync_move, f"never observed sync.action='move' across {len(snapshots)} snapshots"


@pytest.mark.functional
def test_async_task_transitions_running_to_done(bot, task_arena):
    """D: /task/start runs an async — verify task.status transitions
    running → done within 8s."""
    r = bot.post("/task/start", {"action": "wait", "args": {"seconds": 3}}, timeout=10)
    assert r.get("ok"), r
    saw_running = False
    final_status = None
    deadline = time.time() + 8.0
    while time.time() < deadline:
        info = (_get_task(bot).get("data") or {}).get("task") or {}
        st = info.get("status")
        if st == "running":
            saw_running = True
        if st in ("done", "error", "cancelled"):
            final_status = st
            break
        time.sleep(0.05)
    assert saw_running, "never observed task.status='running'"
    assert final_status == "done", f"final task.status={final_status!r}, not 'done'"
