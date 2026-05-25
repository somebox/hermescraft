#!/usr/bin/env python3
"""Append-only capture of Hermes cognition + selected bot log lines for landfolk QA.

Writes under $LOG_DIR/cognition/:
  <profile>.jsonl   — reasoning, assistant content, tool calls/results (full text)
  bot-events.jsonl  — deduped bot log lines ([till], chat, traps, etc.)

State cursors live in $LOG_DIR/state/cognition-record.json so restarts resume
without replaying whole sessions.

Started by `scripts/landfolk start` (cognition-recorder daemon). Run manually:

  LOG_DIR=/tmp/hermescraft python3 -u scripts/landfolk-cognition-record.py
  python3 scripts/landfolk-cognition-record.py --once --profiles mason
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from hermes_session_lib import (
    expand_message_records,
    load_messages,
    load_session_document,
    message_event_time,
    parse_bot_log_timestamp,
    parse_iso_dt,
    session_times_from_path,
    session_files_for_profile,
    short_ts_local_prefix,
)

LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))
STATE_DIR = LOG_DIR / "state"
COGNITION_DIR = LOG_DIR / "cognition"
STATE_FILE = STATE_DIR / "cognition-record.json"
ROSTER_FILE = Path(
    os.environ.get("ROSTER_FILE", str(LOG_DIR / "active-players"))
)

BOT_LINE_RE = re.compile(
    r"\[Chat\]|\[Whisper\]|\[Queued|Kicked:|Disconnected:|Reconnect|Connected!|Spawned at|"
    r"\[till\]|\[reactive\]|STUCK detected|ERROR \[|native no-op|PaperMCP fallback"
)
GLOBAL_CHAT_RE = re.compile(r"\[(Chat|Whisper|Overheard)\]")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"profiles": {}, "chat_dedup": []}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def roster_profiles() -> list[str]:
    env = os.environ.get("COGNITION_PROFILES", "").strip()
    if env:
        return [p.strip().lower() for p in env.split(",") if p.strip()]
    if ROSTER_FILE.is_file():
        out = []
        for line in ROSTER_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            out.append(line.split()[0].lower())
        if out:
            return out
    return ["flint", "mason", "steward"]


def profile_state(state: dict, profile: str) -> dict:
    profiles = state.setdefault("profiles", {})
    ps = profiles.setdefault(profile, {})
    ps.setdefault("sessions", {})
    ps.setdefault("bot_offset", 0)
    return ps


def append_jsonl(path: Path, record: dict) -> None:
    COGNITION_DIR.mkdir(parents=True, exist_ok=True)
    recorded_at = utc_now()
    out = {**record, "recorded_at": record.get("recorded_at") or recorded_at}
    if "ts" not in out or not out.get("ts"):
        out["ts"] = recorded_at
        out.setdefault("ts_source", "ingest")
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(out, ensure_ascii=False) + "\n")


def ingest_session_file(
    profile: str,
    sess: Path,
    sessions: dict,
    out_path: Path,
) -> bool:
    sess_key = str(sess.resolve())
    cursor = int(sessions.get(sess_key, 0))
    doc = load_session_document(sess)
    msgs = load_messages(sess)
    if len(msgs) <= cursor:
        return False
    meta = session_times_from_path(sess, doc)
    start_dt = parse_iso_dt(meta.get("session_start"))
    end_dt = parse_iso_dt(meta.get("session_last_updated"))
    n = len(msgs)
    for i in range(cursor, len(msgs)):
        event_ts, ts_source = message_event_time(
            session_start=start_dt,
            session_end=end_dt,
            msg_index=i,
            message_count=n,
            msg=msgs[i],
        )
        for rec in expand_message_records(
            profile,
            sess.name,
            i,
            msgs[i],
            include_tool_results=True,
            event_ts=event_ts,
            ts_source=ts_source,
            session_start=meta.get("session_start"),
            session_last_updated=meta.get("session_last_updated"),
        ):
            append_jsonl(out_path, rec)
    sessions[sess_key] = len(msgs)
    return True


def poll_bot_log(
    profile: str,
    ps: dict,
    chat_dedup: dict[str, None],
) -> bool:
    bot_log = LOG_DIR / f"bot-{profile}.log"
    off = int(ps.get("bot_offset") or 0)
    try:
        size = bot_log.stat().st_size
    except FileNotFoundError:
        return False
    if size < off:
        off = 0
    if size <= off:
        return False
    try:
        with bot_log.open("r", encoding="utf-8", errors="replace") as fh:
            fh.seek(off)
            chunk = fh.read()
            ps["bot_offset"] = fh.tell()
    except OSError:
        return False

    bot_out = COGNITION_DIR / "bot-events.jsonl"
    any_new = False
    for line in chunk.splitlines():
        if not BOT_LINE_RE.search(line):
            continue
        key = line.rstrip()
        if GLOBAL_CHAT_RE.search(line):
            if key in chat_dedup:
                continue
            chat_dedup[key] = None
            while len(chat_dedup) > 400:
                chat_dedup.pop(next(iter(chat_dedup)))
            append_jsonl(
                bot_out,
                {
                    "profile": "chat",
                    "kind": "bot",
                    "text": key,
                    "source_log": bot_log.name,
                    **(
                        {"ts": parse_bot_log_timestamp(key), "ts_source": "bot_log"}
                        if parse_bot_log_timestamp(key)
                        else {}
                    ),
                },
            )
        else:
            bot_ts = parse_bot_log_timestamp(key)
            rec = {
                "profile": profile,
                "kind": "bot",
                "text": key,
                "source_log": bot_log.name,
            }
            if bot_ts:
                rec["ts"] = bot_ts
                rec["ts_source"] = "bot_log"
            append_jsonl(bot_out, rec)
        any_new = True
    return any_new


def poll_profile(
    profile: str,
    state: dict,
    chat_dedup: dict[str, None],
    *,
    session_hours: float,
    backfill_bot_log: bool,
) -> bool:
    any_new = False
    ps = profile_state(state, profile)
    sessions = ps.setdefault("sessions", {})
    out_path = COGNITION_DIR / f"{profile}.jsonl"

    for sess in session_files_for_profile(profile, max_age_hours=session_hours):
        if ingest_session_file(profile, sess, sessions, out_path):
            any_new = True

    if backfill_bot_log:
        ps["bot_offset"] = 0
        ps["bot_log_backfilled"] = True
    if poll_bot_log(profile, ps, chat_dedup):
        any_new = True

    return any_new


def run_loop(
    profiles: list[str],
    poll: float,
    once: bool,
    session_hours: float,
    backfill_bot_log: bool,
) -> int:
    state = load_state()
    chat_list = state.get("chat_dedup") or []
    chat_dedup: dict[str, None] = {k: None for k in chat_list if isinstance(k, str)}

    while True:
        for p in profiles:
            poll_profile(
                p,
                state,
                chat_dedup,
                session_hours=session_hours,
                backfill_bot_log=backfill_bot_log,
            )
        state["chat_dedup"] = list(chat_dedup.keys())[-400:]
        save_state(state)
        if once:
            break
        time.sleep(poll)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Record Hermes cognition to LOG_DIR/cognition/*.jsonl")
    ap.add_argument("--profiles", default="", help="comma-separated (default: roster / active-players)")
    ap.add_argument("--poll", type=float, default=1.0)
    ap.add_argument("--once", action="store_true", help="single poll then exit (backfill new lines only)")
    ap.add_argument(
        "--session-hours",
        type=float,
        default=float(os.environ.get("COGNITION_SESSION_HOURS", "72")),
        help="include all session files touched in this window (default 72)",
    )
    ap.add_argument(
        "--backfill-bot-log",
        action="store_true",
        help="re-read each profile bot-*.log from start (one shot per profile when combined with --once)",
    )
    args = ap.parse_args()
    profiles = (
        [p.strip().lower() for p in args.profiles.split(",") if p.strip()]
        if args.profiles
        else roster_profiles()
    )
    if not profiles:
        print("no profiles", file=sys.stderr)
        return 1
    COGNITION_DIR.mkdir(parents=True, exist_ok=True)
    print(f"cognition-recorder: profiles={','.join(profiles)} dir={COGNITION_DIR}", flush=True)
    return run_loop(
        profiles,
        args.poll,
        args.once,
        args.session_hours,
        args.backfill_bot_log,
    )


if __name__ == "__main__":
    raise SystemExit(main())
