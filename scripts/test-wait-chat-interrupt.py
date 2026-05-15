#!/usr/bin/env python3
"""test-wait-chat-interrupt.py — F55.5 verification.

Verifies `mc wait N` returns early when a chat message arrives that
either @-mentions the bot or is delivered as direct/whisper. The whole
point: bots can't coordinate if they're deaf during pauses.

Scenarios:
  A — `mc wait 10` with no chat arriving. Expect ~10s, interrupted=false.
  B — `mc wait 10`, an @flint mention arrives at ~2s. Expect ~2s,
      interrupted=true, by=Rcon, reason=mention.
  C — `mc wait 10` with `--no-interrupt`, an @flint mention arrives.
      Expect full ~10s wait (opt-out honored), interrupted=false.
  D — `mc wait 10`, a generic non-mention public chat arrives. Expect
      full ~10s wait (broadcast not relevant to me).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
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


def delayed_say(delay: float, msg: str) -> threading.Thread:
    def _do():
        time.sleep(delay)
        rcon_batch([f"execute in {WORLD} run say {msg}"])
    t = threading.Thread(target=_do, daemon=True)
    t.start()
    return t


def scenario_no_chat(bot_url: str) -> bool:
    print("\n=== A: mc wait 10 with no chat → ~10s, interrupted=false ===")
    t0 = time.time()
    r = http_post(f"{bot_url}/action/wait", {"seconds": 10}, timeout=15)
    dt = time.time() - t0
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    interrupted = data.get("interrupted")
    print(f"  dt={dt:.1f}s  ok={ok}  interrupted={interrupted}  elapsed_s={data.get('elapsed_s')}")
    passed = ok and interrupted is False and 9.0 <= dt <= 11.5
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_mention_interrupts(bot_url: str) -> bool:
    print("\n=== B: mc wait 10, @flint mention at 2s → ~2s, interrupted=true ===")
    delayed_say(2.0, "@flint hi there")
    t0 = time.time()
    r = http_post(f"{bot_url}/action/wait", {"seconds": 10}, timeout=15)
    dt = time.time() - t0
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    interrupted = data.get("interrupted")
    print(f"  dt={dt:.1f}s  ok={ok}  interrupted={interrupted}  by={data.get('by')}  reason={data.get('reason')}")
    print(f"  msg={data.get('message')!r}")
    passed = ok and interrupted is True and 1.5 <= dt <= 4.0 and data.get("reason") == "mention"
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_no_interrupt_flag(bot_url: str) -> bool:
    print("\n=== C: mc wait 10 --no-interrupt, @flint at 2s → ~10s, interrupted=false ===")
    delayed_say(2.0, "@flint anybody home")
    t0 = time.time()
    r = http_post(f"{bot_url}/action/wait", {"seconds": 10, "interrupt": False}, timeout=15)
    dt = time.time() - t0
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    interrupted = data.get("interrupted")
    print(f"  dt={dt:.1f}s  ok={ok}  interrupted={interrupted}")
    passed = ok and interrupted is False and 9.0 <= dt <= 11.5
    print(f"  → {'PASS' if passed else 'FAIL'}")
    return passed


def scenario_generic_broadcast(bot_url: str) -> bool:
    print("\n=== D: mc wait 10, generic non-mention chat at 2s → ~10s wait ===")
    delayed_say(2.0, "anyone want to chat about cats")
    t0 = time.time()
    r = http_post(f"{bot_url}/action/wait", {"seconds": 10}, timeout=15)
    dt = time.time() - t0
    ok = bool(r.get("ok"))
    data = r.get("data") or {}
    interrupted = data.get("interrupted")
    print(f"  dt={dt:.1f}s  ok={ok}  interrupted={interrupted}")
    passed = ok and interrupted is False and 9.0 <= dt <= 11.5
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

    # Make sure bot is named Flint (the mention regex looks for the bot's
    # username). If it's something else, the test should still work but
    # adjust the message addressee.
    bot_name = (s.get("data") or {}).get("username") or "Flint"
    print(f"Bot username: {bot_name}")

    results = [
        ("A", scenario_no_chat(args.bot_url)),
        ("B", scenario_mention_interrupts(args.bot_url)),
        ("C", scenario_no_interrupt_flag(args.bot_url)),
        ("D", scenario_generic_broadcast(args.bot_url)),
    ]

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    return 0 if all(ok for _, ok in results) else 1


if __name__ == "__main__":
    sys.exit(main())
