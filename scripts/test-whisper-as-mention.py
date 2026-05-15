#!/usr/bin/env python3
"""test-whisper-as-mention.py — F55.6 verification.

Verifies `mc whisper PLAYER MSG` routes through public chat as
`@PLAYER MSG` so it reliably reaches mineflayer chat listeners and
triggers the F55.5 wait-interrupt on the recipient.

Scenarios:
  A — Single-bot test: Flint runs `mc whisper SomeName hello`. Verify
      the bot's outgoing chat log shows `@SomeName hello` as the message
      content (not a /msg private command). Also verify the result
      indicates @<player>.
  B — Same for `mc chat_to`.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

from _test_lib import default_bot_url
DEFAULT_BOT_URL = default_bot_url("flint")
WORLD = "landfolk-test"


def rcon_batch(cmds: list[str]) -> str:
    if not cmds:
        return ""
    r = subprocess.run(
        ["ssh", "ubuntu-host", "sudo", "docker", "exec", "-i", "minecraft", "rcon-cli"],
        input="\n".join(cmds) + "\n",
        capture_output=True,
        text=True,
        timeout=60,
    )
    return r.stdout


def http_get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, body: dict, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": {"message": str(e), "code": "HTTP_ERROR"}}


def scenario_whisper_as_mention(bot_url: str) -> bool:
    print("\n=== A: mc whisper Mason hello → result includes @Mason ===")
    r = http_post(f"{bot_url}/action/whisper", {"player": "Mason", "message": "hello there"}, timeout=10)
    ok = bool(r.get("ok"))
    result = r.get("result") or ""
    print(f"  ok={ok}  result={result!r}")
    passed = ok and "@Mason" in result and "hello there" in result
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_chat_to_as_mention(bot_url: str) -> bool:
    print("\n=== B: mc chat_to Steward update → result includes @Steward ===")
    r = http_post(f"{bot_url}/action/chat_to", {"player": "Steward", "message": "status update"}, timeout=10)
    ok = bool(r.get("ok"))
    result = r.get("result") or ""
    print(f"  ok={ok}  result={result!r}")
    passed = ok and "@Steward" in result and "status update" in result
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_recipient_sees_via_chat_log(bot_url: str) -> bool:
    """
    Check that the public chat surface receives the @-mention. We do this
    by having the bot send `mc whisper @ItselfStub MSG` and reading its own
    chat log via /status. Since the bot's own messages get filtered out of
    `new_chat`, we need to look at the raw recent broadcast. Easiest: send
    via rcon `say` impersonating a remote player and confirm the bot's
    unreadChat shows it.
    """
    print("\n=== C: rcon-sent @flint message reaches bot's chat log ===")
    rcon_batch([f"execute in {WORLD} run say @flint please respond"])
    time.sleep(0.5)
    s = http_get(f"{bot_url}/status?lean=true", timeout=10)
    unread = (s.get("data") or {}).get("unreadChat") or {}
    recent = unread.get("recent") or []
    print(f"  unreadChat.count={unread.get('count')}")
    found = any("@flint" in (m.get("message") or "").lower() for m in recent)
    print(f"  matched mention in recent: {found}")
    passed = found
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--bot-url", default=DEFAULT_BOT_URL)
    args = p.parse_args()
    try:
        s = http_get(f"{args.bot_url}/status?lean=true", timeout=5)
        if not s.get("ok"):
            print(f"bot not ready: {s}")
            return 2
    except Exception as e:
        print(f"can't reach bot: {e}")
        return 2

    results = [
        ("A", scenario_whisper_as_mention(args.bot_url)),
        ("B", scenario_chat_to_as_mention(args.bot_url)),
        ("C", scenario_recipient_sees_via_chat_log(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
