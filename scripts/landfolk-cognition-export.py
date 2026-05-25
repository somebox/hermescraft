#!/usr/bin/env python3
"""Bundle cognition JSONL + recent session JSON for offline analysis (e.g. Mason till loops).

  python3 scripts/landfolk-cognition-export.py mason -o /tmp/mason-debug
  python3 scripts/landfolk-cognition-export.py mason --tail 200 --grep till
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from hermes_session_lib import (
    expand_message_records,
    load_messages,
    load_session_document,
    message_event_time,
    session_times_from_path,
    session_files_for_profile,
)

LOG_DIR = Path(os.environ.get("LOG_DIR", "/tmp/hermescraft"))
COGNITION_DIR = LOG_DIR / "cognition"


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def tail_jsonl(path: Path, n: int, grep: str | None) -> list[dict]:
    if not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if grep:
        pat = re.compile(grep, re.I)
        lines = [ln for ln in lines if pat.search(ln)]
    picked = lines[-n:] if n else lines
    out = []
    for ln in picked:
        try:
            out.append(json.loads(ln))
        except json.JSONDecodeError:
            continue
    return out


def export_profile(
    profile: str,
    out_dir: Path,
    tail: int,
    grep: str | None,
    session_hours: float,
) -> None:
    profile = profile.lower()
    out_dir.mkdir(parents=True, exist_ok=True)
    cog = COGNITION_DIR / f"{profile}.jsonl"
    records = tail_jsonl(cog, tail, grep)
    (out_dir / f"{profile}-cognition.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + ("\n" if records else ""),
        encoding="utf-8",
    )

    sess_dir = out_dir / "sessions"
    sess_dir.mkdir(exist_ok=True)
    flat: list[dict] = []
    session_names: list[str] = []
    for sess in session_files_for_profile(profile, max_age_hours=session_hours):
        shutil.copy2(sess, sess_dir / sess.name)
        session_names.append(sess.name)
        doc = load_session_document(sess)
        msgs = load_messages(sess)
        meta = session_times_from_path(sess, doc)
        start_s, end_s = meta.get("session_start"), meta.get("session_last_updated")
        start_dt = end_dt = None
        if start_s:
            try:
                start_dt = datetime.fromisoformat(start_s.replace("Z", "+00:00"))
            except ValueError:
                pass
        if end_s:
            try:
                end_dt = datetime.fromisoformat(end_s.replace("Z", "+00:00"))
            except ValueError:
                pass
        n = len(msgs)
        for i, m in enumerate(msgs):
            ets, tsrc = message_event_time(
                session_start=start_dt,
                session_end=end_dt,
                msg_index=i,
                message_count=n,
                msg=m,
            )
            flat.extend(
                expand_message_records(
                    profile,
                    sess.name,
                    i,
                    m,
                    event_ts=ets,
                    ts_source=tsrc,
                    session_start=start_s,
                    session_last_updated=end_s,
                )
            )
    if grep:
        pat = re.compile(grep, re.I)
        flat = [r for r in flat if pat.search(r.get("text") or "")]
    (out_dir / f"{profile}-session-flat.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in flat) + ("\n" if flat else ""),
        encoding="utf-8",
    )

    bot_log = LOG_DIR / f"bot-{profile}.log"
    if bot_log.is_file():
        shutil.copy2(bot_log, out_dir / bot_log.name)

    agent_log = LOG_DIR / f"agent-{profile}.log"
    if agent_log.is_file():
        shutil.copy2(agent_log, out_dir / agent_log.name)

    bot_events = COGNITION_DIR / "bot-events.jsonl"
    if bot_events.is_file():
        ev = [r for r in tail_jsonl(bot_events, tail, grep) if r.get("profile") in (profile, "chat")]
        (out_dir / f"{profile}-bot-events.jsonl").write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in ev) + ("\n" if ev else ""),
            encoding="utf-8",
        )

    meta = {
        "profile": profile,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "cognition_source": str(cog),
        "sessions": session_names,
        "session_hours": session_hours,
        "tail": tail,
        "grep": grep,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("profile", help="flint, mason, steward, …")
    ap.add_argument("-o", "--output", help="output directory (default LOG_DIR/cognition/exports/<profile>-<ts>)")
    ap.add_argument("--tail", type=int, default=500, help="jsonl lines to include (0 = all)")
    ap.add_argument("--grep", help="filter jsonl / flat export (regex)")
    ap.add_argument(
        "--session-hours",
        type=float,
        default=72.0,
        help="include session JSON from both homes modified in this window",
    )
    args = ap.parse_args()
    out = Path(args.output) if args.output else COGNITION_DIR / "exports" / f"{args.profile.lower()}-{utc_stamp()}"
    export_profile(args.profile, out, args.tail, args.grep, args.session_hours)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
