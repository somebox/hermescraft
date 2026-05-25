#!/usr/bin/env python3
"""landfolk-chat-wake — wake idle kanban bots when an operator whispers them.

Each canonical landfolk bot exposes `GET /chat?count=N` on its HTTP API port.
Entries with `whisper: true` are direct messages (`/msg <bot> ...` in-game).
When this daemon sees a NEW whisper to a bot that has no kanban worker
running, it files a `[CHAT_REQUEST]` triage card so the dispatcher (or
Steward via the auto-promote ritual) spawns a worker that reads the chat
queue and replies.

This complements steward-chat-listener.py (which handles public `@steward`
mentions on Steward's own port). This daemon handles 1:1 whispers to any
landfolk bot.

State (per-bot last_seen_ms cursor) lives at
~/.landfolk-chat-wake-state.json so a restart doesn't refile old whispers.

Env:
    POLL_INTERVAL_S   (default 5)
    BOARD             (default landfolk-ops)
    AGENT_MODELS      (default $REPO/data/agent-models.json)
    STATE_FILE        (default ~/.landfolk-chat-wake-state.json)
    SKIP_IF_WORKER    (default 1 — 0 to file cards even when a worker is up)
    DRY_RUN           (default 0)
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "5"))
BOARD = os.environ.get("BOARD", "landfolk-ops")
SKIP_IF_WORKER = os.environ.get("SKIP_IF_WORKER", "1") == "1"
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
STATE_FILE = Path(os.environ.get(
    "STATE_FILE", str(Path.home() / ".landfolk-chat-wake-state.json")
))

REPO_ROOT = Path(__file__).resolve().parent.parent
AGENT_MODELS = Path(os.environ.get("AGENT_MODELS", str(REPO_ROOT / "data" / "agent-models.json")))

# Bots we never re-trigger on (avoid bot-to-bot wake loops). Lowercase.
BOT_NAMES = {
    "flint", "mason", "gatherer", "barley", "steward",
    "steve", "reed", "moss", "ember", "tester", "rcon", "server", "builder",
    "worker-a", "worker-b",
}


def load_agents():
    """Returns dict of {name_lower: api_port}."""
    data = json.loads(AGENT_MODELS.read_text())
    agents = data.get("agents", {})
    return {name.lower(): int(cfg.get("api_port")) for name, cfg in agents.items() if cfg.get("api_port")}


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state))


def http_get_json(url, timeout=4):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError, json.JSONDecodeError):
        return None


def fetch_chat(port):
    """Return list of chat-log entries (newest last) or None if unreachable."""
    data = http_get_json(f"http://127.0.0.1:{port}/chat?count=20")
    if not data or not data.get("ok"):
        return None
    return data.get("data", {}).get("messages", []) or []


def has_kanban_worker(bot_name):
    """True if a `hermes -p <bot> ... kanban task ...` process is running."""
    try:
        out = subprocess.run(
            ["ps", "-eo", "command="], capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        return False
    pat = re.compile(rf"hermes -p {re.escape(bot_name)}\b.*\bkanban task\b")
    return any(pat.search(line) for line in out.splitlines())


def create_chat_request(bot, sender, message, msg_ms):
    snippet = (message or "").strip().replace("\n", " ")
    if len(snippet) > 60:
        snippet = snippet[:57] + "..."
    title = f"[CHAT_REQUEST] {bot}: {snippet}"
    when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(msg_ms / 1000))
    body = (
        f"Whisper to {bot} from @{sender} at {when}.\n\n"
        f"Original message:\n  {message.strip()}\n\n"
        f"Action: read your chat queue (`mc read_chat 20`), act on what {sender} "
        f"asked (acknowledge, answer, or carry out the request), and update "
        f"memory before completing. If the request is ambiguous, reply to "
        f"{sender} via `mc chat \"{sender}: ...\"` and block this card with a "
        f"clarifying question."
    )
    cmd = [
        "hermes", "kanban", "--board", BOARD, "create", title,
        "--assignee", bot,
        "--priority", "95",
        "--triage",
        "--body", body,
        "--idempotency-key", f"chat-wake-{bot}-{msg_ms}",
        "--created-by", f"{sender}-via-whisper",
    ]
    if DRY_RUN:
        print(f"DRY: {' '.join(cmd[:9])} ... (body suppressed)")
        return None
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        print(f"ERR create {bot}: {r.stderr.strip()[:200]}")
        return None
    out = (r.stdout or "").strip()
    m = re.search(r"t_[0-9a-f]+", out)
    return m.group(0) if m else "(id-unknown)"


def main():
    try:
        agents = load_agents()
    except FileNotFoundError:
        print(f"FATAL: agent-models.json not found at {AGENT_MODELS}", file=sys.stderr)
        sys.exit(1)
    print(f"landfolk-chat-wake: watching {len(agents)} bots for whispers → cards on {BOARD}")
    print(f"  poll every {POLL_INTERVAL_S}s, state at {STATE_FILE}")
    if DRY_RUN:
        print("  DRY_RUN=1 — no cards will be created")
    print(f"  bots: {', '.join(sorted(agents))}")

    state = load_state()

    def stop(_sig, _frm):
        print("\nstopping; state saved")
        save_state(state)
        sys.exit(0)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    # Seed cursors to "now" for bots we've never seen — avoids spamming on
    # first run if there are old whispers in the chat log.
    now_ms = int(time.time() * 1000)
    seeded = False
    for bot in agents:
        if bot not in state:
            state[bot] = {"last_seen_ms": now_ms}
            seeded = True
    if seeded:
        save_state(state)

    while True:
        for bot, port in agents.items():
            try:
                msgs = fetch_chat(port)
            except Exception as e:
                print(f"  {bot}: poll error: {e}")
                continue
            if msgs is None:
                continue  # bot not reachable; skip silently

            cursor = int(state.get(bot, {}).get("last_seen_ms", 0))
            new_whispers = []
            newest_ms = cursor
            for ev in msgs:
                ms = int(ev.get("time", 0))
                if ms > newest_ms:
                    newest_ms = ms
                if ms <= cursor:
                    continue
                if not ev.get("whisper"):
                    continue
                sender = str(ev.get("from", "")).strip()
                if not sender or sender.lower() in BOT_NAMES:
                    continue
                message = str(ev.get("message", "")).strip()
                if not message:
                    continue
                new_whispers.append((ms, sender, message))

            for ms, sender, message in new_whispers:
                if SKIP_IF_WORKER and has_kanban_worker(bot):
                    print(f"[{time.strftime('%H:%M:%S')}] {bot} ← @{sender}: worker already running, skipping card")
                    continue
                print(f"[{time.strftime('%H:%M:%S')}] {bot} ← @{sender}: {message[:120]}")
                tid = create_chat_request(bot, sender, message, ms)
                if tid:
                    print(f"  filed {tid}")

            if newest_ms > cursor:
                state[bot] = {"last_seen_ms": newest_ms}
                save_state(state)

        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()
