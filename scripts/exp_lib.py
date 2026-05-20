#!/usr/bin/env python3
"""Common helpers for /tmp/hermescraft/runs/<RUN_ID>/ structured logging.

Used by scripts/exp.sh and the analyze sub-command.  Centralised so we
have ONE place that knows how to parse `mc status` output (it sometimes
returns a string for `holding` instead of an object, etc — too easy to
shred a quick shell pipeline on that).

Convention (see docs/experiments/run-logging.md):
  /tmp/hermescraft/runs/<RUN_ID>/    — one dir per test run
    meta.json
    agent.log, bot.log
    positions.jsonl, events.jsonl
    midchecks/T+<N>m.log
    summary.md
  /tmp/hermescraft/runs/current      — symlink to the active run
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

RUNS_ROOT = Path("/tmp/hermescraft/runs")
CURRENT_LINK = RUNS_ROOT / "current"
MC_BIN = "/Users/foz/.local/bin/mc"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def now_epoch() -> int:
    return int(time.time())


def resolve_run_dir(arg: Optional[str]) -> Path:
    """Return the run directory for the given RUN_ID or 'current' if None."""
    if arg in (None, "", "current"):
        if not CURRENT_LINK.exists():
            raise SystemExit(
                f"No active run (symlink {CURRENT_LINK} missing). "
                f"Start one with `scripts/exp.sh start <slug>`."
            )
        return CURRENT_LINK.resolve()
    p = RUNS_ROOT / arg
    if not p.exists():
        raise SystemExit(f"Run dir not found: {p}")
    return p


def mc_run(args: list[str]) -> dict[str, Any]:
    """Run an mc CLI command and return the parsed JSON envelope.

    Falls back to a synthetic {ok: false, raw: '...'} if the output isn't
    parseable as JSON.  Never raises on missing fields.
    """
    proc = subprocess.run(
        [MC_BIN, *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    out = proc.stdout
    # The CLI sometimes prefixes with a human-readable header; pull out the
    # last '{"ok":' object on the line.
    m = re.search(r'\{"ok":.*\}', out)
    if not m:
        return {"ok": False, "raw": out, "stderr": proc.stderr}
    try:
        return json.loads(m.group())
    except json.JSONDecodeError:
        return {"ok": False, "raw": out, "stderr": proc.stderr}


def status_snapshot() -> dict[str, Any]:
    """Return a stable shape: {ts, x, y, z, hp, food, holding, time, phase, ok}."""
    env = mc_run(["status"])
    if not env.get("ok"):
        return {"ts": now_iso(), "ok": False, "raw": env.get("raw", "")}
    d = env.get("data", {})
    pos = d.get("position") or {}
    holding = d.get("holding")
    # `holding` is sometimes a string ("empty"), sometimes an object {name, count}.
    if isinstance(holding, dict):
        holding_name = holding.get("name")
    elif isinstance(holding, str):
        holding_name = holding if holding != "empty" else None
    else:
        holding_name = None
    return {
        "ts": now_iso(),
        "ok": True,
        "x": pos.get("x"),
        "y": pos.get("y"),
        "z": pos.get("z"),
        "hp": d.get("health"),
        "food": d.get("food"),
        "saturation": d.get("saturation"),
        "holding": holding_name,
        "time": d.get("time"),
        "phase": d.get("phase"),
    }


def task_snapshot() -> dict[str, Any]:
    """Return {action, status, target, elapsed_s} for the current bg task, or None fields."""
    env = mc_run(["task"])
    if not env.get("ok"):
        return {"action": None, "status": None, "target": None, "elapsed_s": None}
    t = (env.get("data", {}) or {}).get("task") or {}
    result = (t.get("result") or {})
    err = (result.get("error") or {})
    return {
        "action": t.get("action"),
        "status": t.get("status"),
        "target": err.get("observed_state", {}).get("target") if isinstance(err.get("observed_state"), dict) else None,
        "elapsed_s": t.get("elapsed_s"),
        "error_code": err.get("code"),
    }


def deaths_snapshot() -> dict[str, Any]:
    """Return {total, deathNumber, last_pos, seconds_ago, items_lost}."""
    env = mc_run(["deaths"])
    if not env.get("ok"):
        return {"total": 0, "deathNumber": 0, "last_pos": None, "seconds_ago": None, "items_lost": None}
    d = env.get("data", {}) or {}
    last = d.get("last_death")
    if not last:
        return {"total": d.get("total", 0), "deathNumber": 0, "last_pos": None, "seconds_ago": None, "items_lost": None}
    return {
        "total": d.get("total", 0),
        "deathNumber": last.get("deathNumber", 0),
        "last_pos": last.get("position"),
        "seconds_ago": last.get("seconds_ago"),
        "items_lost": last.get("items_lost"),
    }


def append_jsonl(run_dir: Path, name: str, record: dict[str, Any]) -> None:
    path = run_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def read_meta(run_dir: Path) -> dict[str, Any]:
    p = run_dir / "meta.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text())


def write_meta(run_dir: Path, data: dict[str, Any]) -> None:
    (run_dir / "meta.json").write_text(json.dumps(data, indent=2) + "\n")


def haversine_blocks(a: dict, b: dict) -> float:
    """Distance between two {x, y, z} positions (treating Minecraft as Euclidean)."""
    if not a or not b:
        return 0.0
    if a.get("x") is None or b.get("x") is None:
        return 0.0
    return math.sqrt(
        (a["x"] - b["x"]) ** 2
        + (a.get("y", 0) - b.get("y", 0)) ** 2
        + (a["z"] - b["z"]) ** 2
    )


# ─── CLI sub-commands (invoked by scripts/exp.sh) ──────────────────────────

def cmd_poll_once(args: list[str]) -> int:
    """Append one positions+events sample. Usage: exp_lib.py poll-once <run-id>"""
    run_dir = resolve_run_dir(args[0] if args else None)
    s = status_snapshot()
    t = task_snapshot()
    d = deaths_snapshot()
    record = {**s, "task_action": t["action"], "task_status": t["status"], "deaths_total": d["total"]}
    append_jsonl(run_dir, "positions.jsonl", record)
    # Event detection: low HP, low food, new death, nav error.
    events: list[dict] = []
    if s.get("ok") and s.get("hp") is not None and s["hp"] < 8:
        events.append({"ts": s["ts"], "kind": "low_hp", "hp": s["hp"], "pos": {"x": s["x"], "y": s["y"], "z": s["z"]}})
    if s.get("ok") and s.get("food") is not None and s["food"] < 6:
        events.append({"ts": s["ts"], "kind": "low_food", "food": s["food"]})
    if t.get("error_code") and t["error_code"] != "OPERATION_TIMEOUT":
        events.append({"ts": s["ts"], "kind": "nav_error", "code": t["error_code"], "target": t.get("target")})
    # New-death detection: gate on deathNumber changing since last poll,
    # NOT on seconds_ago < 35. circuit-v1 fired a false positive at T+0
    # because Steve had a stale deathNumber=2 record from a prior
    # session and seconds_ago happened to read fresh on first poll.
    # State persisted in run_dir/.last_death_number to survive poller
    # restarts.
    last_death_file = run_dir / ".last_death_number"
    last_num = 0
    if last_death_file.exists():
        try: last_num = int(last_death_file.read_text().strip())
        except: last_num = 0
    cur_num = int(d.get("deathNumber") or 0)
    if cur_num > last_num:
        events.append({
            "ts": s["ts"], "kind": "death",
            "deathNumber": cur_num,
            "at": d["last_pos"], "items_lost": d["items_lost"],
        })
        last_death_file.write_text(str(cur_num))
    for e in events:
        append_jsonl(run_dir, "events.jsonl", e)
    return 0


def cmd_midcheck(args: list[str]) -> int:
    """Write a snapshot midchecks/T+<elapsed>m.log. Usage: midcheck [<run-id>]"""
    run_dir = resolve_run_dir(args[0] if args else None)
    meta = read_meta(run_dir)
    start_ts = meta.get("start_ts", now_epoch())
    elapsed_s = now_epoch() - start_ts
    label = f"T+{elapsed_s // 60}m"
    midcheck_dir = run_dir / "midchecks"
    midcheck_dir.mkdir(exist_ok=True)
    out = midcheck_dir / f"{label}.log"
    s = status_snapshot()
    t = task_snapshot()
    d = deaths_snapshot()
    waypoints = meta.get("waypoints", {})
    lines = [
        f"=== {label} ===",
        f"ts: {s['ts']}",
        f"pos: ({s['x']:.1f},{s['y']},{s['z']:.1f}) hp={s['hp']} food={s['food']} holding={s['holding']}"
        if s.get("ok") else f"status_failed: {s.get('raw','')[:200]}",
        f"task: action={t['action']} status={t['status']} elapsed_s={t['elapsed_s']} err={t.get('error_code')}",
        f"deaths: total={d['total']} last_seconds_ago={d['seconds_ago']}",
    ]
    if waypoints and s.get("ok"):
        for name, (x, _y, z, item) in sorted(waypoints.items()):
            dist = math.sqrt((s["x"] - x) ** 2 + (s["z"] - z) ** 2)
            lines.append(f"  {name} ({item}): {dist:.0f}")
    out.write_text("\n".join(lines) + "\n")
    print(f"wrote {out}")
    append_jsonl(run_dir, "events.jsonl", {"ts": now_iso(), "kind": "midcheck", "label": label})
    print("\n".join(lines))
    return 0


def cmd_status(args: list[str]) -> int:
    """Print live state of the current (or named) run."""
    run_dir = resolve_run_dir(args[0] if args else None)
    meta = read_meta(run_dir)
    start_ts = meta.get("start_ts", now_epoch())
    elapsed = now_epoch() - start_ts
    s = status_snapshot()
    print(f"run:     {run_dir.name}")
    print(f"slug:    {meta.get('slug', '?')}")
    print(f"elapsed: {elapsed // 60}m {elapsed % 60}s")
    if s.get("ok"):
        print(f"steve:   ({s['x']:.1f},{s['y']},{s['z']:.1f}) hp={s['hp']} food={s['food']} holding={s['holding']}")
    else:
        print(f"steve:   status FAILED — {s.get('raw','')[:200]}")
    # Position count
    pcount = sum(1 for _ in (run_dir / "positions.jsonl").open()) if (run_dir / "positions.jsonl").exists() else 0
    ecount = sum(1 for _ in (run_dir / "events.jsonl").open()) if (run_dir / "events.jsonl").exists() else 0
    print(f"samples: {pcount} positions, {ecount} events")
    return 0


def cmd_analyze(args: list[str]) -> int:
    """Compute summary stats from positions.jsonl + events.jsonl."""
    run_dir = resolve_run_dir(args[0] if args else None)
    positions = read_jsonl(run_dir / "positions.jsonl")
    events = read_jsonl(run_dir / "events.jsonl")
    meta = read_meta(run_dir)
    print(f"run: {run_dir.name}  slug: {meta.get('slug','?')}")
    print(f"positions: {len(positions)}  events: {len(events)}")
    if not positions:
        print("no position data yet")
        return 0
    total_dist = 0.0
    prev = None
    for p in positions:
        if p.get("ok") is False:
            continue
        if prev is not None:
            total_dist += haversine_blocks(prev, p)
        prev = p
    duration_s = sum(1 for p in positions) * 30  # rough: 30s per sample
    print(f"total walked: {total_dist:.0f} blocks over ~{duration_s // 60}m")
    if duration_s:
        rate = total_dist / (duration_s / 60)
        print(f"effective pace: {rate:.1f} blocks/min")
    # Event breakdown
    from collections import Counter
    kinds = Counter(e.get("kind") for e in events)
    if kinds:
        print("events by kind:")
        for k, n in sorted(kinds.items(), key=lambda x: -x[1]):
            print(f"  {k}: {n}")
    # Final state
    last = positions[-1]
    if last.get("ok") is not False:
        print(f"final pos: ({last.get('x',0):.1f},{last.get('y','?')},{last.get('z',0):.1f}) hp={last.get('hp')} food={last.get('food')}")
    return 0


COMMANDS = {
    "poll-once": cmd_poll_once,
    "midcheck": cmd_midcheck,
    "status": cmd_status,
    "analyze": cmd_analyze,
}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print("usage: exp_lib.py {poll-once|midcheck|status|analyze} [run-id]", file=sys.stderr)
        return 2
    return COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    sys.exit(main())
