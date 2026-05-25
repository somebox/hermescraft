"""Shared helpers for reading Hermes landfolk session JSON (kanban + continuous homes)."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

_SESSION_ID_RE = re.compile(
    r"session_(?P<date>\d{8})_(?P<time>\d{6})_(?P<suffix>[a-f0-9]+)\.json$",
    re.I,
)
_BOT_LOG_TS_RE = re.compile(r"^\[(\d{1,2}:\d{2}:\d{2} [AP]M)\]")


def candidate_homes(profile: str) -> list[Path]:
    profile = profile.lower()
    return [
        Path.home() / f".hermes-landfolk-{profile}",
        Path.home() / ".hermes" / "profiles" / profile,
    ]


def newest_session(profile: str) -> Path | None:
    best: Path | None = None
    best_mtime = -1.0
    for home in candidate_homes(profile):
        sess_dir = home / "sessions"
        if not sess_dir.is_dir():
            continue
        for f in sess_dir.glob("session_*.json"):
            try:
                mt = f.stat().st_mtime
            except OSError:
                continue
            if mt > best_mtime:
                best_mtime = mt
                best = f
    return best


def session_files_for_profile(profile: str, *, max_age_hours: float = 72.0) -> list[Path]:
    """All session JSON files under both homes, newest activity first.

    Kanban may run parallel workers (two session files with the same dispatch
    second). Steward continuous uses ~/.hermes-landfolk-steward while kanban
    steward cards use ~/.hermes/profiles/steward — capture both when active.
    """
    import time

    cutoff = time.time() - max(0.0, max_age_hours) * 3600.0
    seen: set[Path] = set()
    out: list[Path] = []
    for home in candidate_homes(profile):
        sess_dir = home / "sessions"
        if not sess_dir.is_dir():
            continue
        for f in sess_dir.glob("session_*.json"):
            try:
                rp = f.resolve()
                if rp in seen:
                    continue
                if f.stat().st_mtime < cutoff:
                    continue
            except OSError:
                continue
            seen.add(rp)
            out.append(f)
    out.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return out


def load_messages(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    if isinstance(data, list):
        return data
    return list(data.get("messages") or [])


def load_session_document(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _parse_iso_dt(raw: str | None) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip()
    try:
        if s.endswith("Z"):
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def session_times_from_path(path: Path, doc: dict[str, Any] | None = None) -> dict[str, Any]:
    """Best-effort session window for timestamp interpolation.

    Hermes session JSON usually has session_start + last_updated at file level;
    individual messages often have no created_at. Filename embeds start second.
    """
    doc = doc if doc is not None else load_session_document(path)
    start = _parse_iso_dt(doc.get("session_start"))
    end = _parse_iso_dt(doc.get("last_updated"))
    m = _SESSION_ID_RE.search(path.name)
    if start is None and m:
        try:
            start = datetime.strptime(
                f"{m.group('date')}{m.group('time')}", "%Y%m%d%H%M%S"
            ).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    if end is None:
        try:
            end = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            end = start
    if start is None and end is not None:
        start = end
    return {
        "session_start": start.isoformat() if start else None,
        "session_last_updated": end.isoformat() if end else None,
        "session_id": doc.get("session_id")
        or (path.stem.removeprefix("session_") if path.name.startswith("session_") else path.stem),
    }


def message_event_time(
    *,
    session_start: datetime | None,
    session_end: datetime | None,
    msg_index: int,
    message_count: int,
    msg: dict[str, Any],
) -> tuple[str | None, str]:
    """Return (iso_ts, ts_source). Prefer message created_at when Hermes adds it."""
    for key in ("created_at", "timestamp", "ts", "time"):
        dt = _parse_iso_dt(msg.get(key) if isinstance(msg.get(key), str) else None)
        if dt is not None:
            return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"), "message"
    if session_start is None or session_end is None or message_count <= 0:
        return None, "unknown"
    if message_count == 1:
        return session_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"), "session_start"
    span = (session_end - session_start).total_seconds()
    if span <= 0:
        frac = msg_index / max(1, message_count - 1)
    else:
        frac = msg_index / max(1, message_count - 1)
    dt = session_start + timedelta(seconds=span * frac)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"), "interpolated"


def parse_iso_dt(raw: str | None) -> datetime | None:
    return _parse_iso_dt(raw)


def short_ts_local_prefix(iso_ts: str | None) -> str:
    """Eight-char local time column (matches JSONL `ts` when shown to operator)."""
    dt = _parse_iso_dt(iso_ts)
    if dt is None:
        return "        "
    return dt.astimezone().strftime("%H:%M:%S")


def parse_bot_log_timestamp(line: str) -> str | None:
    m = _BOT_LOG_TS_RE.match((line or "").strip())
    if not m:
        return None
    try:
        now = datetime.now().astimezone()
        local = datetime.strptime(m.group(1), "%I:%M:%S %p")
        local = local.replace(year=now.year, month=now.month, day=now.day, tzinfo=now.tzinfo)
        if local > now:
            local -= timedelta(days=1)
        return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def assistant_reasoning(msg: dict) -> str:
    return (msg.get("reasoning_content") or msg.get("reasoning") or "").strip()


def expand_message_records(
    profile: str,
    session_name: str,
    msg_index: int,
    msg: dict[str, Any],
    *,
    include_tool_results: bool = True,
    truncate_tool: int | None = None,
    event_ts: str | None = None,
    ts_source: str | None = None,
    session_start: str | None = None,
    session_last_updated: str | None = None,
) -> list[dict[str, Any]]:
    """Flatten one session message into zero or more JSONL-ready records (full text)."""
    role = msg.get("role")
    base: dict[str, Any] = {
        "profile": profile.lower(),
        "session": session_name,
        "msg_index": msg_index,
    }
    if event_ts:
        base["ts"] = event_ts
    if ts_source:
        base["ts_source"] = ts_source
    if session_start:
        base["session_start"] = session_start
    if session_last_updated:
        base["session_last_updated"] = session_last_updated
    out: list[dict[str, Any]] = []

    if role == "user":
        text = (msg.get("content") or "").strip()
        if text:
            out.append({**base, "kind": "user", "text": text})
        return out

    if role == "assistant":
        reasoning = assistant_reasoning(msg)
        content = (msg.get("content") or "").strip()
        if reasoning and reasoning != content:
            out.append({**base, "kind": "reasoning", "text": reasoning})
        if content:
            out.append({**base, "kind": "content", "text": content})
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function") or {}
            name = fn.get("name", "?")
            args = fn.get("arguments", "")
            if not isinstance(args, str):
                args = json.dumps(args, ensure_ascii=False)
            rec: dict[str, Any] = {
                **base,
                "kind": "tool_call",
                "tool_name": name,
                "text": args,
            }
            out.append(rec)
        return out

    if role == "tool" and include_tool_results:
        raw = msg.get("content", "")
        if not isinstance(raw, str):
            raw = json.dumps(raw, ensure_ascii=False)
        text = raw
        if truncate_tool and len(text) > truncate_tool:
            text = text[: truncate_tool - 1] + "…"
        is_error = _tool_is_error(raw)
        out.append(
            {
                **base,
                "kind": "tool_result",
                "text": text,
                "is_error": is_error,
                "tool_name": msg.get("name"),
            }
        )
    return out


def _tool_is_error(raw: str) -> bool:
    low = (raw or "").lower()
    if "[error]" in low or '"ok": false' in low or '"ok":false' in low:
        return True
    try:
        d = json.loads(raw)
        if isinstance(d, dict):
            out = d.get("output")
            if isinstance(out, str) and out.lstrip().startswith("ERROR"):
                return True
            if d.get("ok") is False:
                return True
    except Exception:
        pass
    return False
