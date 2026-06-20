#!/usr/bin/env python3
"""card_story.py — reconstruct the true per-card story of a genesis-v2 (or any hermes
kanban) run by merging, into ONE time-sorted event sequence per card:

  1. Goal / agent / bot          (kanban title+body+assignee; bot best-effort)
  2. Comments & end state        (kanban comments + status/result/summary)
  3. Reasoning / decision chain  (the agent's OBSERVABLE trace: ordered tool calls +
                                  turn boundaries + its own comments/chat)
  4. Tool calls                  (name, ok/error, duration — from agent.log)

Correlation key: session_id. Cards carry it; agent.log lines are tagged `[session_id]`
and a `conversation turn: ... msg='work kanban task t_XXX'` line maps each session to its
card. A card may be re-dispatched across several sessions; all are merged.

HONEST LIMITATIONS (so summaries aren't over-trusted):
  - The agent's hidden chain-of-thought TEXT is NOT in agent.log (only response_len /
    finish_reason). The per-turn request dumps that held it are wiped on re-mint. What we
    reconstruct is the externalized decision trace (tool sequence + the agent's comments).
  - Bot identity (Mox/Pip/Zee) isn't on the card; recovered best-effort from terminal
    output, else "unknown".

Usage:
  scripts/card_story.py [--board genesis-v2] [--card t_XXXX] [--out DIR]
                        [--profiles ~/.hermes/profiles] [--json]
  # default: whole board → markdown per card + INDEX.md under --out (default: stdout summary)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

# agent.log line: "2026-06-20 13:24:41,886 INFO [SESSION] logger: message"
LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+\s+(?P<lvl>\w+)\s+"
    r"(?:\[(?P<sess>[0-9a-f_]+)\]\s+)?(?P<logger>[\w.]+):\s+(?P<msg>.*)$"
)
# NB: these match the MESSAGE body only — LINE_RE already strips the `logger:` prefix.
TURN_TASK_RE = re.compile(r"msg='work kanban task (t_[a-z0-9]+)'")
TOOL_OK_RE = re.compile(r"^tool (?P<name>\S+) completed \((?P<dur>[\d.]+)s, (?P<chars>\d+) chars\)")
TOOL_ERR_RE = re.compile(r"^Tool (?P<name>\S+) returned error \((?P<dur>[\d.]+)s\): (?P<body>.*)$")
TURN_END_RE = re.compile(r"Turn ended: reason=(?P<reason>\S+)")
API_RE = re.compile(r"API call #(?P<n>\d+): .*in=(?P<in>\d+) out=(?P<out>\d+)")


def _ts(s: str) -> float:
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S").timestamp()


def hermes(args: list[str], board: str) -> dict | list:
    out = subprocess.run(["hermes", "kanban", "--board", board, *args],
                         capture_output=True, text=True)
    try:
        return json.loads(out.stdout or "[]")
    except Exception:
        return []


def parse_agent_logs(profiles: Path) -> tuple[dict, dict]:
    """Returns (session->task map, session->[events]). Events are
    {t, kind, detail} drawn from agent.log across all colony-* profiles."""
    sess_task: dict[str, str] = {}
    sess_events: dict[str, list] = {}
    for log in sorted(profiles.glob("colony-*/logs/agent.log")):
        profile = log.parent.parent.name
        try:
            lines = log.read_text(errors="replace").splitlines()
        except Exception:
            continue
        for ln in lines:
            m = LINE_RE.match(ln)
            if not m:
                continue
            sess = m.group("sess")
            if not sess:
                continue
            t = _ts(m.group("ts"))
            msg = m.group("msg")
            logger = m.group("logger")
            tm = TURN_TASK_RE.search(msg) if logger == "agent.conversation_loop" else None
            if tm:
                sess_task[sess] = tm.group(1)
                sess_events.setdefault(sess, []).append(
                    {"t": t, "kind": "turn_start", "detail": f"begin work on {tm.group(1)}", "profile": profile})
                continue
            ok = TOOL_OK_RE.search(msg)
            if ok:
                sess_events.setdefault(sess, []).append(
                    {"t": t, "kind": "tool", "detail": f"{ok.group('name')} ok ({ok.group('dur')}s, {ok.group('chars')}c)",
                     "tool": ok.group("name"), "ok": True, "profile": profile})
                continue
            er = TOOL_ERR_RE.search(msg)
            if er:
                body = er.group("body")[:120]
                sess_events.setdefault(sess, []).append(
                    {"t": t, "kind": "tool", "detail": f"{er.group('name')} ERROR: {body}",
                     "tool": er.group("name"), "ok": False, "profile": profile})
                continue
            te = TURN_END_RE.search(msg)
            if te:
                sess_events.setdefault(sess, []).append(
                    {"t": t, "kind": "turn_end", "detail": f"turn ended ({te.group('reason')})", "profile": profile})
    return sess_task, sess_events


def card_story(card_id: str, board: str, sess_task: dict, sess_events: dict) -> dict:
    d = hermes(["show", card_id, "--json"], board)
    if not isinstance(d, dict):
        return {"id": card_id, "error": "no data"}
    t = d.get("task", d)
    events = d.get("events") or []
    comments = d.get("comments") or []

    # sessions that worked this card: agent.log map is authoritative. Only fall back to
    # the card's own session_id field if that session isn't already mapped to a DIFFERENT
    # task (the field can be stale and would otherwise bleed another card's trace in).
    sessions = sorted({s for s, tid in sess_task.items() if tid == card_id})
    own = t.get("session_id")
    if own and own not in sessions and sess_task.get(own) in (None, card_id):
        sessions.append(own)
        sessions.sort()

    # merge into one timeline
    timeline = []
    for e in events:
        timeline.append({"t": float(e.get("created_at") or 0), "src": "board",
                         "kind": e.get("kind"),
                         "detail": _board_evt_detail(e)})
    for c in comments:
        timeline.append({"t": float(c.get("created_at") or 0), "src": "comment",
                         "kind": "comment", "detail": (c.get("body") or "").strip()})
    tool_calls = []
    for s in sessions:
        for ev in sess_events.get(s, []):
            timeline.append({"t": ev["t"], "src": f"agent:{ev.get('profile','?')}",
                             "kind": ev["kind"], "detail": ev["detail"]})
            if ev["kind"] == "tool":
                tool_calls.append({"tool": ev.get("tool"), "ok": ev.get("ok"), "t": ev["t"]})
    timeline.sort(key=lambda x: x["t"])

    # bot best-effort: prefer an explicit `leased_bot=X` in a comment, else any body name.
    bot = "unknown"
    blob = json.dumps(d)
    lm = re.search(r"leased_bot[=:\s]+([A-Za-z]+)", blob)
    if lm:
        bot = lm.group(1)
    else:
        bm = re.search(r"\b(Mox|Pip|Zee|tester|Tester)\b", blob)
        if bm:
            bot = bm.group(1)

    return {
        "id": card_id,
        "title": t.get("title"),
        "goal": (t.get("body") or "").strip(),
        "agent": t.get("assignee"),
        "bot": bot,
        "status": t.get("status"),
        "result": t.get("result"),
        "summary": d.get("latest_summary"),
        "created_at": t.get("created_at"),
        "completed_at": t.get("completed_at"),
        "sessions": sessions,
        "comments": [{"by": c.get("author"), "body": (c.get("body") or "").strip()} for c in comments],
        "end_state": _end_state(events, t),
        "tool_calls": tool_calls,
        "timeline": timeline,
    }


def _board_evt_detail(e: dict) -> str:
    p = e.get("payload") or {}
    k = e.get("kind")
    if k == "gave_up":
        return f"gave_up: {str(p.get('error'))[:120]}"
    if k == "completed":
        return f"completed: {str(p.get('summary') or '')[:120]}"
    if k == "blocked":
        return f"blocked: {str(p.get('reason') or '')[:120]}"
    if k in ("claimed", "spawned"):
        return f"{k} (run {p.get('run_id')}, pid {p.get('pid','')})"
    if k == "protocol_violation":
        return f"protocol_violation (pid {p.get('pid')}, rc {p.get('exit_code')})"
    return k


def _end_state(events: list, t: dict) -> str:
    kinds = [e.get("kind") for e in events]
    gu = kinds.count("gave_up")
    parts = [f"status={t.get('status')}"]
    if gu:
        parts.append(f"gave_up×{gu}")
    if kinds.count("protocol_violation"):
        parts.append(f"protocol_violation×{kinds.count('protocol_violation')}")
    if "completed" in kinds:
        parts.append("completed")
    if "blocked" in kinds:
        parts.append("blocked")
    return ", ".join(parts)


def to_markdown(story: dict) -> str:
    from collections import Counter
    tc = story.get("tool_calls") or []
    tool_counts = Counter(c["tool"] for c in tc)
    tool_errs = Counter(c["tool"] for c in tc if c.get("ok") is False)
    lines = [
        f"# {story.get('title')}  (`{story['id']}`)",
        "",
        "## 1. Goal / agent / bot",
        f"- **Agent:** {story.get('agent')}  |  **Bot:** {story.get('bot')}  |  **Sessions:** {len(story.get('sessions') or [])}",
        f"- **Goal:**",
        "",
        "```",
        (story.get("goal") or "")[:1200],
        "```",
        "",
        "## 2. Comments & end state",
        f"- **End state:** {story.get('end_state')}",
        f"- **Summary:** {story.get('summary') or '—'}",
        "",
    ]
    for c in story.get("comments") or []:
        lines.append(f"- _{c['by']}_: {c['body'][:400]}")
    lines += ["", "## 4. Tool calls", ""]
    if tool_counts:
        for name, n in tool_counts.most_common():
            e = tool_errs.get(name, 0)
            lines.append(f"- `{name}`: {n}{f'  ({e} errors)' if e else ''}")
    else:
        lines.append("- (none recorded)")
    lines += ["", "## 3. Reasoning / decision chain (time-sorted)", "",
              "_Observable trace — tool sequence + comments. Hidden chain-of-thought text is not persisted._", ""]
    for ev in story.get("timeline") or []:
        ts = datetime.fromtimestamp(ev["t"]).strftime("%H:%M:%S") if ev["t"] else "--:--:--"
        d = ev["detail"].replace("\n", " ")[:200]
        lines.append(f"- `{ts}` [{ev['src']}/{ev['kind']}] {d}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", default="genesis-v2")
    ap.add_argument("--card", help="single card id; default = whole board")
    ap.add_argument("--out", help="output dir for per-card markdown + INDEX.md")
    ap.add_argument("--profiles", default=os.path.expanduser("~/.hermes/profiles"))
    ap.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    args = ap.parse_args()

    sess_task, sess_events = parse_agent_logs(Path(args.profiles))
    sys.stderr.write(f"[card_story] indexed {len(sess_task)} sessions, "
                     f"{sum(len(v) for v in sess_events.values())} agent events\n")

    if args.card:
        ids = [args.card]
    else:
        lst = hermes(["list", "--json"], args.board)
        ts = lst if isinstance(lst, list) else lst.get("tasks", [])
        ids = [t.get("id") for t in ts if t.get("id")]

    stories = [card_story(cid, args.board, sess_task, sess_events) for cid in ids]

    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        idx = ["# Card stories — board summary", "",
               "| card | agent | bot | end state | tools | comments |",
               "|---|---|---|---|---|---|"]
        for s in sorted(stories, key=lambda x: (x.get("agent") or "", x.get("id"))):
            (out / f"{s['id']}.md").write_text(to_markdown(s))
            ntools = len(s.get("tool_calls") or [])
            nerr = sum(1 for c in (s.get("tool_calls") or []) if c.get("ok") is False)
            idx.append(f"| [{s['id']}]({s['id']}.md) | {s.get('agent')} | {s.get('bot')} | "
                       f"{s.get('end_state')} | {ntools} ({nerr} err) | {len(s.get('comments') or [])} |")
        (out / "INDEX.md").write_text("\n".join(idx))
        sys.stderr.write(f"[card_story] wrote {len(stories)} card files + INDEX.md to {out}\n")
        print(str(out / "INDEX.md"))
    elif args.json:
        print(json.dumps(stories, indent=2, default=str))
    else:
        for s in stories:
            print(to_markdown(s))
            print("\n" + "=" * 80 + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
