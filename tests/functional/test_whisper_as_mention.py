"""F55.6: `mc whisper PLAYER MSG` routes through public chat as `@PLAYER MSG`.

Migrated from scripts/test-whisper-as-mention.py. Public-chat routing
matters because mineflayer's chat listeners only fire on broadcast
messages — private `/msg`-style channels would not trigger the F55.5
wait-interrupt logic on the recipient. F55.6 ensures `mc whisper` and
`mc chat_to` send through the broadcast channel with an `@PLAYER`
prefix that the agent's mention-detection still matches.

Scenarios:
  A: `mc whisper Mason hello there` → result contains `@Mason` + message.
  B: `mc chat_to Steward status update` → result contains `@Steward` + message.
  C: rcon-impersonated `@tester please respond` reaches the bot's unreadChat.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def chat_bot(rcon, tester_bot):
    """No arena setup — these tests don't touch the world, only chat I/O."""
    return tester_bot


@pytest.mark.functional
def test_whisper_routes_as_at_mention(chat_bot):
    """A: result string carries `@Mason` and the message body."""
    r = chat_bot.post("/action/whisper", {"player": "Mason", "message": "hello there"}, timeout=10)
    assert r.get("ok"), r
    result = r.get("result") or ""
    assert "@Mason" in result, result
    assert "hello there" in result, result


@pytest.mark.functional
def test_chat_to_routes_as_at_mention(chat_bot):
    """B: same contract for the chat_to verb."""
    r = chat_bot.post("/action/chat_to", {"player": "Steward", "message": "status update"}, timeout=10)
    assert r.get("ok"), r
    result = r.get("result") or ""
    assert "@Steward" in result, result
    assert "status update" in result, result


@pytest.mark.functional
def test_external_at_mention_reaches_bot_unread_chat(rcon, chat_bot, config):
    """C: an rcon-sent `say @tester ...` lands in the bot's unreadChat queue.

    The bot's own messages get filtered out of new_chat; the easiest way
    to prove the broadcast channel is wired is to impersonate a remote
    player via the server's `say` command and verify the bot saw it.
    """
    world = config["mc"]["world"]
    rcon.run(f"execute in {world} run say @tester please respond")
    import time
    time.sleep(0.5)
    s = chat_bot.get("/status?lean=true", timeout=10)
    unread = (s.get("data") or {}).get("unreadChat") or {}
    recent = unread.get("recent") or []
    matched = any("@tester" in (m.get("message") or "").lower() for m in recent)
    assert matched, unread
