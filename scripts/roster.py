#!/usr/bin/env python3
"""Landfolk roster — who's actually in-game and ready to receive kanban work.

Steward (and any human operator) should call this before assigning or
reassigning a card. It reads data/agent-models.json for the canonical
profile→role→port mapping, hits each bot's /health endpoint, and prints
a compact table (default) or JSON.

Usage:
    scripts/roster.py            # human table
    scripts/roster.py --json     # machine-readable
    scripts/roster.py --online   # exit non-zero if any expected bot is offline

Profiles missing from agent-models.json are skipped. A profile with no
running bot listener on its api_port is reported as OFFLINE — do NOT
assign new cards to it; the dispatcher will spawn a worker that exits
immediately and the card will loop back to ready.

Note: this checks the *bot listener* (mineflayer process), not whether
the player is currently visible in-world. A bot can be listening on its
port but disconnected from MC (kicked + waiting on watchdog reconnect),
in which case `mc_connected` will be false even though the listener is up.
Only assign to profiles where `online: true` AND `mc_connected: true`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_JSON = REPO_ROOT / "data" / "agent-models.json"


def load_roster() -> dict:
    try:
        return json.loads(MODELS_JSON.read_text())
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"error: cannot read {MODELS_JSON}: {e}", file=sys.stderr)
        sys.exit(2)


def probe(port: int, timeout: float = 1.5) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return None


def build_status(roster: dict) -> list[dict]:
    rows = []
    for name, spec in (roster.get("agents") or {}).items():
        port = spec.get("api_port")
        role = spec.get("role", "?")
        h = probe(port) if port else None
        online = h is not None
        mc_connected = bool(h and h.get("connected"))
        pos = (h or {}).get("position") or {}
        rows.append({
            "name": name,
            "lower": name.lower(),
            "role": role,
            "port": port,
            "online": online,
            "mc_connected": mc_connected,
            "holding": (h or {}).get("holding"),
            "pos": [pos.get("x"), pos.get("y"), pos.get("z")] if pos else None,
            "uptime_sec": (h or {}).get("uptime_sec"),
            "assignable": online and mc_connected,
        })
    return rows


def print_table(rows: list[dict]) -> None:
    print(f"{'profile':<10} {'role':<12} {'port':<6} {'state':<14} {'pos':<22} {'holding':<14}")
    for r in rows:
        if not r["online"]:
            state = "OFFLINE"
        elif not r["mc_connected"]:
            state = "listener-only"  # bot up, but disconnected from MC
        else:
            state = "ASSIGNABLE"
        pos = ",".join(f"{x:.1f}" if isinstance(x, (int, float)) else "?" for x in (r["pos"] or [0, 0, 0])) if r["pos"] else "-"
        holding = r["holding"] or "-"
        print(f"{r['lower']:<10} {r['role']:<12} {str(r['port'] or '-'):<6} {state:<14} {pos:<22} {holding:<14}")
    print()
    assignable = [r["lower"] for r in rows if r["assignable"]]
    print(f"ASSIGNABLE profiles right now: {', '.join(assignable) if assignable else '(none)'}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    ap.add_argument("--online", action="store_true",
                    help="exit non-zero if any expected agent is OFFLINE (CI gate)")
    ap.add_argument("--assignable", action="store_true",
                    help="print one assignable profile name per line (suitable for scripting)")
    args = ap.parse_args()

    roster = load_roster()
    rows = build_status(roster)

    if args.assignable:
        for r in rows:
            if r["assignable"]:
                print(r["lower"])
        return 0
    if args.json:
        print(json.dumps({"agents": rows}, indent=2))
    else:
        print_table(rows)

    if args.online:
        offline = [r["lower"] for r in rows if not r["online"]]
        if offline:
            print(f"OFFLINE: {', '.join(offline)}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
