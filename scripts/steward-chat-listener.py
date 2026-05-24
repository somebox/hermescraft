#!/usr/bin/env python3
"""Steward chat listener — watches one running bot's chat for `@steward <message>`
from real players and creates a triage card on landfolk-ops.

Usage:
    BOT_PORT=3002 BOARD=landfolk-ops python3 scripts/steward-chat-listener.py

Polls the bot at :$BOT_PORT every POLL_INTERVAL_S seconds via the local `mc`
CLI's `social` verb (which surfaces public-mention events with timestamps).
For each new mention of "@steward" from a non-bot actor:

  1. `hermes kanban --board $BOARD create "<text>" --assignee steward --triage \
        --idempotency-key chat-<msg_time>`
  2. (optional) `hermes kanban decompose <id>`  if AUTO_DECOMPOSE=1
  3. Ack in-game via `mc chat "@<player> triaged as <id>"` through the watched bot.

State (last-processed message timestamp) lives at ~/.steward-listener-state.json
so a restart doesn't re-trigger old messages.

Stop with Ctrl-C.

Env:
    BOT_PORT          (default 3005 — Steward's own bot; was 3002 Flint pre-2026-05-25)
    BOARD             (default landfolk-ops)
    POLL_INTERVAL_S   (default 5)
    AUTO_DECOMPOSE    (default 0 — set 1 to auto-decompose after triage)
    STATE_FILE        (default ~/.steward-listener-state.json)
    DRY_RUN           (default 0 — set 1 to log what would happen without creating)
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

BOT_PORT = int(os.environ.get("BOT_PORT", "3005"))  # Steward's own bot
BOARD = os.environ.get("BOARD", "landfolk-ops")
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "5"))
AUTO_DECOMPOSE = os.environ.get("AUTO_DECOMPOSE", "0") == "1"
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
STATE_FILE = Path(os.environ.get("STATE_FILE", str(Path.home() / ".steward-listener-state.json")))

REPO_ROOT = Path(__file__).resolve().parent.parent
MC = str(REPO_ROOT / "bin" / "mc")

# Bots we do NOT triage messages from (avoid bot-to-bot loops).
BOT_NAMES = {"flint", "mason", "gatherer", "barley", "steve", "reed", "moss", "ember", "tester", "rcon", "server", "builder"}

STEWARD_TRIGGER = re.compile(r"@steward\b\s*[,:!.\-]*\s*(.+?)$", re.IGNORECASE | re.DOTALL)


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"last_seen_ms": 0}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state))


def mc_call(verb_and_args, port=BOT_PORT, timeout=10):
    env = {**os.environ, "MC_API_URL": f"http://localhost:{port}"}
    return subprocess.run(
        [MC, *verb_and_args],
        capture_output=True, text=True, env=env, timeout=timeout,
    )


def fetch_recent_events():
    """Returns list of {time, actor, channel, message} sorted oldest→newest."""
    r = mc_call(["social", "--json"])
    if r.returncode != 0:
        return []
    try:
        out = json.loads(r.stdout)
    except Exception:
        return []
    return out.get("data", {}).get("recent_events", [])


def create_triage(text, requester, msg_time_ms):
    title = text.strip()
    if len(title) > 80:
        title = title[:77] + "..."
    body = (
        f"Triaged from in-game chat by @{requester} at "
        f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(msg_time_ms / 1000))}.\n\n"
        f"Original message:\n  {text.strip()}\n\n"
        f"Steward: review this triage card when you next plan — promote with "
        f"hermes kanban specify/assign, decompose into worker cards with explicit "
        f"assignees (flint, mason, gatherer) after scripts/roster.py --assignable. "
        f"If clarification is needed, post a kanban_comment — re44 may answer via @steward in chat."
    )
    cmd = [
        "hermes", "kanban", "--board", BOARD, "create", title,
        "--assignee", "steward", "--triage",
        "--body", body,
        "--idempotency-key", f"chat-{msg_time_ms}",
        "--created-by", f"{requester}-via-chat",
        "--json",
    ]
    if DRY_RUN:
        print(f"DRY: {' '.join(cmd[:7])} ... (full body suppressed)")
        return None
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"ERR create: {r.stderr.strip()[:200]}")
        return None
    # CLI prints "Created t_xxx (...)" — parse the id either from JSON or text
    out = r.stdout.strip()
    m = re.search(r"t_[0-9a-f]+", out)
    return m.group(0) if m else None


def decompose(task_id):
    if not AUTO_DECOMPOSE or DRY_RUN:
        return
    r = subprocess.run(
        ["hermes", "kanban", "--board", BOARD, "decompose", task_id],
        capture_output=True, text=True,
    )
    if r.returncode == 0:
        print(f"  decomposed → {r.stdout.strip()[:200]}")
    else:
        print(f"  decompose failed: {r.stderr.strip()[:200]}")


def ack_in_chat(requester, task_id):
    msg = f"@{requester} triaged as {task_id}"
    if DRY_RUN:
        print(f"DRY: mc chat \"{msg}\"")
        return
    mc_call(["chat", msg])


def main():
    print(f"steward-chat-listener: watching bot :{BOT_PORT} for @steward mentions on board {BOARD}")
    print(f"  poll every {POLL_INTERVAL_S}s, state at {STATE_FILE}")
    if DRY_RUN:
        print("  DRY_RUN=1 — no cards will be created")

    state = load_state()

    def stop(_sig, _frm):
        print("\nstopping; state saved")
        save_state(state)
        sys.exit(0)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    while True:
        try:
            events = fetch_recent_events()
        except Exception as e:
            print(f"  poll error: {e}")
            time.sleep(POLL_INTERVAL_S)
            continue

        for ev in events:
            ms = int(ev.get("time", 0))
            if ms <= state["last_seen_ms"]:
                continue
            if ev.get("kind") != "heard":
                continue
            actor = str(ev.get("actor", "")).lower()
            if not actor or actor in BOT_NAMES:
                continue
            msg = str(ev.get("message", ""))
            m = STEWARD_TRIGGER.search(msg)
            if not m:
                continue
            request_text = m.group(1).strip()
            if not request_text:
                continue
            print(f"[{time.strftime('%H:%M:%S')}] @steward from {actor}: {request_text[:120]}")
            tid = create_triage(request_text, actor, ms)
            if tid:
                print(f"  created {tid}")
                decompose(tid)
                ack_in_chat(actor, tid)
            state["last_seen_ms"] = max(state["last_seen_ms"], ms)
            save_state(state)

        # Advance last_seen even if nothing matched, so we don't keep
        # re-scanning the same old events. Use the newest event time we saw.
        if events:
            newest = max(int(e.get("time", 0)) for e in events)
            if newest > state["last_seen_ms"]:
                state["last_seen_ms"] = newest
                save_state(state)
        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()
