"""F55.5: `mc wait N` returns early on @-mentions; ignores generic chat.

Migrated from scripts/test-wait-chat-interrupt.py. Bots that can't be
interrupted during a `mc wait` are deaf to coordination requests. F55.5
adds the early-return logic. Four scenarios:
  A: wait 10 with no chat → full duration, interrupted=false.
  B: wait 10 + @tester mention at ~2s → returns ~2s, interrupted=true.
  C: wait 10 with interrupt=false + @tester mention → full duration.
  D: wait 10 + non-mention public chat at ~2s → full duration.
"""

from __future__ import annotations

import threading
import time

import pytest

pytestmark = pytest.mark.slow


@pytest.fixture
def chat_bot(tester_bot):
    return tester_bot


def _delayed_say(rcon, world: str, delay: float, msg: str) -> threading.Thread:
    """rcon-impersonate a chat message after `delay` seconds."""
    def _do():
        time.sleep(delay)
        rcon.run(f"execute in {world} run say {msg}")
    t = threading.Thread(target=_do, daemon=True)
    t.start()
    return t


@pytest.mark.functional
def test_wait_no_chat_runs_full_duration(chat_bot):
    """A: 10s wait with no chat → completes near 10s, not interrupted."""
    t0 = time.time()
    r = chat_bot.post("/action/wait", {"seconds": 10}, timeout=15)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("interrupted") is False, data
    assert 9.0 <= elapsed <= 11.5, f"elapsed={elapsed:.2f} not in [9, 11.5]"


@pytest.mark.functional
def test_wait_interrupts_on_at_mention(rcon, chat_bot, config):
    """B: @tester mention at 2s → wait returns ~2s, interrupted=true, reason=mention."""
    _delayed_say(rcon, config["mc"]["world"], 2.0, "@tester hi there")
    t0 = time.time()
    r = chat_bot.post("/action/wait", {"seconds": 10}, timeout=15)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("interrupted") is True, data
    assert 1.5 <= elapsed <= 4.0, f"elapsed={elapsed:.2f}; should be ~2s"
    assert data.get("reason") == "mention", data


@pytest.mark.functional
def test_wait_with_no_interrupt_ignores_mention(rcon, chat_bot, config):
    """C: same mention but interrupt=false → full duration (opt-out honored)."""
    _delayed_say(rcon, config["mc"]["world"], 2.0, "@tester anybody home")
    t0 = time.time()
    r = chat_bot.post("/action/wait", {"seconds": 10, "interrupt": False}, timeout=15)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("interrupted") is False, data
    assert 9.0 <= elapsed <= 11.5, f"elapsed={elapsed:.2f}; opt-out not honored"


@pytest.mark.functional
def test_wait_ignores_generic_broadcast(rcon, chat_bot, config):
    """D: non-mention chat at 2s → wait runs full duration."""
    _delayed_say(rcon, config["mc"]["world"], 2.0, "anyone want to chat about cats")
    t0 = time.time()
    r = chat_bot.post("/action/wait", {"seconds": 10}, timeout=15)
    elapsed = time.time() - t0
    assert r.get("ok"), r
    data = r.get("data") or {}
    assert data.get("interrupted") is False, data
    assert 9.0 <= elapsed <= 11.5, f"elapsed={elapsed:.2f}; non-mention shouldn't interrupt"
