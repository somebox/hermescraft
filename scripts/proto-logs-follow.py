#!/usr/bin/env python3
"""Follow pilot-pip + pilot-zee worker conversations in real time.

The proto-agent-arch HERMES_HOME stores worker conversations in
``state.db`` (sqlite ``messages`` table), not in the ``session_*.json``
files that ``scripts/landfolk-logs-aggregate.py`` watches. This script
polls those state.db tables and prints new rows with per-profile color,
showing:

  - assistant thoughts        → bright primary color
  - tool calls (mc commands)  → bold primary color, "⚙ <verb args>"
  - tool responses            → dim primary color, "↩ <tool>: <output>"
  - reasoning (with --reasoning) → dim italic, "…<reasoning>"
  - user / handoff context    → neutral grey, "user: …"
  - bot chat                  → bright cyan from /tmp/hermescraft/bot-*.log

Also folds in the dispatcher log (most recent
``/tmp/two-bot-dispatcher-*.log``) so kanban-tick events appear inline.

Usage:
  scripts/proto-logs-follow.py                          # both pilots, follow
  scripts/proto-logs-follow.py --profiles pilot-pip
  scripts/proto-logs-follow.py --tail 50                # backfill last 50 each
  scripts/proto-logs-follow.py --no-follow --no-color
  scripts/proto-logs-follow.py --reasoning              # include reasoning
  scripts/proto-logs-follow.py --quiet                  # tool calls + thoughts only
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sqlite3
import sys
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

# ── Defaults ────────────────────────────────────────────────────────

HERMES_HOME = Path(os.environ.get(
    "HERMES_HOME",
    Path.home() / ".hermes-proto-agent-arch",
))
BOT_LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))

# ── Colour palette ──────────────────────────────────────────────────
# (primary, bold, dim) per profile. Bot HTTP usernames map to pilot
# profiles via this table.
PALETTE = {
    "pilot-pip": ("\033[38;5;75m",  "\033[1;38;5;75m",  "\033[2;38;5;75m"),   # blue
    "pilot-zee": ("\033[38;5;114m", "\033[1;38;5;114m", "\033[2;38;5;114m"),  # green
    "pilot-mox": ("\033[38;5;221m", "\033[1;38;5;221m", "\033[2;38;5;221m"),  # gold
}
_FALLBACK = ("\033[38;5;250m", "\033[1;38;5;250m", "\033[2;38;5;250m")
RST = "\033[0m"
META_C = "\033[2;38;5;244m"
USER_C = "\033[38;5;245m"
CHAT_C = "\033[1;38;5;51m"
DISP_C = "\033[1;38;5;208m"

# Map bot usernames (in /tmp/hermescraft/bot-<name>.log) → pilot profile.
BOT_TO_PROFILE = {
    "pip": "pilot-pip",
    "zee": "pilot-zee",
    "mox": "pilot-mox",
}

# Only keep these bot-log line categories (everything else is noise).
_BOT_LOG_FILTER = re.compile(
    r"\[Chat\]|\[Whisper\]|\[collect\]|Connected!|Spawned at|DIED!|Kicked"
)
_BOT_LOG_TS = re.compile(r"^\[(\d+):(\d+):(\d+) ([AP]M)\]")


def palette_for(profile: str):
    return PALETTE.get(profile, _FALLBACK)


# ── state.db reader ─────────────────────────────────────────────────

def state_db_path(profile: str) -> Path:
    return HERMES_HOME / "profiles" / profile / "state.db"


def get_latest_message_id(profile: str) -> int:
    db = state_db_path(profile)
    if not db.exists():
        return 0
    with sqlite3.connect(str(db)) as conn:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()
        return int(row[0]) if row else 0


def fetch_new_messages(profile: str, since_id: int) -> list[sqlite3.Row]:
    db = state_db_path(profile)
    if not db.exists():
        return []
    with sqlite3.connect(str(db)) as conn:
        conn.row_factory = sqlite3.Row
        return list(conn.execute(
            "SELECT id, session_id, role, tool_name, content, tool_calls, "
            "timestamp, reasoning FROM messages "
            "WHERE id > ? ORDER BY id",
            (since_id,),
        ).fetchall())


# ── Formatting ──────────────────────────────────────────────────────

def _short(text: str | None, n: int) -> str:
    if not text:
        return ""
    s = str(text).strip().replace("\n", " | ")
    return s[:n] + ("…" if len(s) > n else "")


def _ts_prefix(ts: float | None, use_color: bool) -> str:
    if not ts:
        return ""
    s = datetime.fromtimestamp(ts).strftime("%H:%M:%S")
    return f"{META_C if use_color else ''}{s}{RST if use_color else ''} "


def format_message(
    profile: str,
    msg: sqlite3.Row,
    *,
    use_color: bool,
    show_reasoning: bool,
    show_ts: bool,
    quiet: bool,
    pad: int,
) -> list[str]:
    primary, bold, dim = palette_for(profile) if use_color else ("", "", "")
    rst = RST if use_color else ""
    user_c = USER_C if use_color else ""

    ts = _ts_prefix(msg["timestamp"], use_color) if show_ts else ""
    label = f"{primary}{profile:>{pad}}{rst}"
    role = msg["role"]
    out: list[str] = []

    if role == "assistant":
        # Reasoning (with --reasoning).
        if show_reasoning and msg["reasoning"]:
            out.append(f"{ts}{label} {dim}…{_short(msg['reasoning'], 220)}{rst}")
        # Tool calls (compressed).
        if msg["tool_calls"]:
            try:
                tcs = json.loads(msg["tool_calls"])
            except (TypeError, json.JSONDecodeError):
                tcs = []
            for tc in tcs:
                fn = tc.get("function") if isinstance(tc, dict) else None
                if not fn:
                    continue
                name = fn.get("name", "?")
                args = fn.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {"_raw": args}
                if name == "terminal":
                    cmd = args.get("input") or args.get("command") or "?"
                    out.append(f"{ts}{label} {bold}⚙ {_short(cmd, 140)}{rst}")
                else:
                    arg_short = _short(json.dumps(args, default=str), 100)
                    out.append(f"{ts}{label} {bold}🔧 {name}{rst} {dim}{arg_short}{rst}")
        # Thought (assistant text).
        content = msg["content"]
        if content and content.strip():
            out.append(f"{ts}{label} {primary}{_short(content, 220)}{rst}")
    elif role == "tool":
        if quiet:
            # Quiet mode drops successful tool responses; only surface errors.
            if not msg["content"] or "ERROR" not in msg["content"]:
                return []
        # Tool response — error vs ok.
        content = msg["content"] or ""
        is_error = "ERROR" in content or '"error"' in content
        col = bold if (use_color and is_error) else dim
        tool_name = msg["tool_name"] or "?"
        arrow = "↪" if is_error else "↩"
        out.append(f"{ts}{label} {col}{arrow} {tool_name}: {_short(content, 200)}{rst}")
    elif role == "user":
        if quiet:
            return []
        content = msg["content"] or ""
        out.append(f"{ts}{label} {user_c}user: {_short(content, 160)}{rst}")
    elif role == "system":
        # System messages are usually noisy — skip unless --no-quiet AND
        # they're short enough to be a directive.
        if quiet or not msg["content"]:
            return []
        out.append(f"{ts}{label} {user_c}sys: {_short(msg['content'], 140)}{rst}")
    return out


# ── Bot log tail ────────────────────────────────────────────────────

def follow_bot_logs(profiles: list[str], offsets: dict[str, int],
                    *, use_color: bool, show_ts: bool, pad: int) -> list[str]:
    out: list[str] = []
    rst = RST if use_color else ""
    chat_c = CHAT_C if use_color else ""
    meta = META_C if use_color else ""
    bot_names = {bot: prof for bot, prof in BOT_TO_PROFILE.items()
                 if prof in profiles}
    for bot, profile in bot_names.items():
        log_path = BOT_LOG_DIR / f"bot-{bot}.log"
        if not log_path.exists():
            continue
        try:
            size = log_path.stat().st_size
        except OSError:
            continue
        prev = offsets.get(bot, size)
        if size <= prev:
            continue
        try:
            with log_path.open("rb") as f:
                f.seek(prev)
                new_bytes = f.read(size - prev)
        except OSError:
            offsets[bot] = size
            continue
        offsets[bot] = size
        for raw in new_bytes.decode("utf-8", errors="replace").splitlines():
            if not _BOT_LOG_FILTER.search(raw):
                continue
            # Re-use the bot log's HH:MM:SS prefix.
            ts = ""
            if show_ts:
                m = _BOT_LOG_TS.match(raw)
                if m:
                    h, mi, s, ampm = m.groups()
                    h_i = int(h) % 12 + (12 if ampm == "PM" else 0)
                    ts = f"{meta}{h_i:02d}:{mi}:{s}{rst} "
            stripped = raw[raw.find("]") + 1:].lstrip() if raw.startswith("[") else raw
            primary, _bold, _dim = palette_for(profile) if use_color else ("", "", "")
            label = f"{primary}{profile:>{pad}}{rst}"
            out.append(f"{ts}{label} {chat_c}[bot] {_short(stripped, 180)}{rst}")
    return out


# ── Dispatcher log tail ─────────────────────────────────────────────

def newest_dispatcher_log() -> Path | None:
    cands = sorted(
        glob.glob("/tmp/two-bot-dispatcher-*.log"),
        key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0,
        reverse=True,
    )
    return Path(cands[0]) if cands else None


def follow_dispatcher_log(state: dict, *, use_color: bool, show_ts: bool,
                          pad: int) -> list[str]:
    out: list[str] = []
    log_path = newest_dispatcher_log()
    if not log_path or not log_path.exists():
        return out
    cur_path = str(log_path)
    if state.get("path") != cur_path:
        # New file rotation — reset offset.
        state["path"] = cur_path
        state["offset"] = log_path.stat().st_size
        return out
    size = log_path.stat().st_size
    prev = state.get("offset", size)
    if size <= prev:
        return out
    try:
        with log_path.open("rb") as f:
            f.seek(prev)
            new_bytes = f.read(size - prev)
    except OSError:
        state["offset"] = size
        return out
    state["offset"] = size
    rst = RST if use_color else ""
    disp_c = DISP_C if use_color else ""
    label = f"{disp_c}{'dispatcher':>{pad}}{rst}"
    # Collapse spammy "Reclaimed: 0 / Crashed: 0 / ..." blocks; only surface
    # ticks where something happened (Spawned: N>0 or any non-zero metric).
    block: list[str] = []
    for raw in new_bytes.decode("utf-8", errors="replace").splitlines():
        if raw.startswith("["):  # timestamp line → flush previous block
            if any(re.match(r"^[A-Z][a-z]+:\s+[1-9]", l) for l in block):
                spawned = [l for l in block if l.startswith("Spawned")]
                tick_ts = block[0] if block and block[0].startswith("[") else ""
                if not spawned:
                    spawned = [l for l in block if re.match(r"^[A-Z][a-z]+:\s+[1-9]", l)]
                ts = ""
                if show_ts and tick_ts:
                    m = re.match(r"^\[(\d{4}-\d{2}-\d{2}T)(\d{2}:\d{2}:\d{2})", tick_ts)
                    if m:
                        ts = f"{META_C if use_color else ''}{m.group(2)}{rst} "
                summary = "; ".join(spawned[:3]) if spawned else _short(block[1] if len(block) > 1 else "", 80)
                out.append(f"{ts}{label} {disp_c}⊞ {summary}{rst}")
            block = [raw]
        else:
            block.append(raw)
    return out


# ── Backfill ────────────────────────────────────────────────────────

def backfill(profile: str, n: int) -> list[sqlite3.Row]:
    db = state_db_path(profile)
    if not db.exists():
        return []
    with sqlite3.connect(str(db)) as conn:
        conn.row_factory = sqlite3.Row
        rows = list(conn.execute(
            "SELECT id, session_id, role, tool_name, content, tool_calls, "
            "timestamp, reasoning FROM messages "
            "ORDER BY id DESC LIMIT ?",
            (n,),
        ).fetchall())
    return list(reversed(rows))


# ── Main loop ───────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profiles", default="pilot-pip,pilot-zee",
                    help="comma-separated list of pilot profiles to follow "
                         "(default: pilot-pip,pilot-zee)")
    ap.add_argument("--tail", type=int, default=0,
                    help="backfill last N messages from each profile before following")
    ap.add_argument("--no-follow", action="store_true",
                    help="exit after backfill (use with --tail)")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--no-bot-logs", action="store_true",
                    help="don't fold in /tmp/hermescraft/bot-*.log chat events")
    ap.add_argument("--no-dispatcher", action="store_true",
                    help="don't fold in /tmp/two-bot-dispatcher-*.log ticks")
    ap.add_argument("--no-timestamps", action="store_true",
                    help="omit HH:MM:SS column")
    ap.add_argument("-q", "--quiet", action="store_true",
                    help="hide successful tool responses + user messages; "
                         "keep thoughts, tool calls, errors")
    ap.add_argument("--reasoning", action="store_true",
                    help="include reasoning_content/reasoning before assistant text")
    ap.add_argument("--poll", type=float, default=1.0,
                    help="poll interval in seconds (default: 1.0)")
    args = ap.parse_args(argv)

    use_color = (not args.no_color) and sys.stdout.isatty()
    show_ts = not args.no_timestamps
    profiles = [p.strip() for p in args.profiles.split(",") if p.strip()]
    if not profiles:
        print("no profiles selected", file=sys.stderr)
        return 64

    pad = max(len(p) for p in profiles + (
        ["dispatcher"] if not args.no_dispatcher else []
    ))

    # Verify each profile's state.db exists.
    missing = [p for p in profiles if not state_db_path(p).exists()]
    if missing:
        for p in missing:
            print(f"warning: state.db missing for {p}: {state_db_path(p)}",
                  file=sys.stderr)

    # ── Backfill ─────────────────────────────────────────────────
    cursors: dict[str, int] = {}
    if args.tail > 0:
        for profile in profiles:
            rows = backfill(profile, args.tail)
            for msg in rows:
                for line in format_message(
                    profile, msg,
                    use_color=use_color, show_reasoning=args.reasoning,
                    show_ts=show_ts, quiet=args.quiet, pad=pad,
                ):
                    print(line)
                cursors[profile] = max(cursors.get(profile, 0), int(msg["id"]))
    # Ensure cursors point at "now" so live-follow doesn't replay history.
    for profile in profiles:
        if profile not in cursors:
            cursors[profile] = get_latest_message_id(profile)

    if args.no_follow:
        return 0

    # ── Live follow ──────────────────────────────────────────────
    bot_log_offsets: dict[str, int] = {}
    if not args.no_bot_logs:
        for bot in BOT_TO_PROFILE:
            log = BOT_LOG_DIR / f"bot-{bot}.log"
            bot_log_offsets[bot] = log.stat().st_size if log.exists() else 0

    dispatcher_state: dict = {}

    try:
        while True:
            had_output = False
            for profile in profiles:
                new_msgs = fetch_new_messages(profile, cursors[profile])
                for msg in new_msgs:
                    for line in format_message(
                        profile, msg,
                        use_color=use_color, show_reasoning=args.reasoning,
                        show_ts=show_ts, quiet=args.quiet, pad=pad,
                    ):
                        print(line)
                        had_output = True
                    cursors[profile] = int(msg["id"])
            if not args.no_bot_logs:
                for line in follow_bot_logs(
                    profiles, bot_log_offsets,
                    use_color=use_color, show_ts=show_ts, pad=pad,
                ):
                    print(line)
                    had_output = True
            if not args.no_dispatcher:
                for line in follow_dispatcher_log(
                    dispatcher_state,
                    use_color=use_color, show_ts=show_ts, pad=pad,
                ):
                    print(line)
                    had_output = True
            if had_output:
                sys.stdout.flush()
            time.sleep(args.poll)
    except KeyboardInterrupt:
        print("", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main())
