#!/usr/bin/env python3
"""Base-wide inventory aggregator — Steward's supply dashboard.

How it works
------------
1. Reads `data/base-goals.yaml` for resource categories + thresholds.
2. Reads every `data/locations-<bot>.json` looking for marks prefixed
   `chest_` — these are operator/Steward-curated base chests.
3. For each registered chest, queries each live bot's `/state` or the
   `chestSnapshots` map for the most recent snapshot at that coord.
4. Aggregates item counts by resource category, prints DEFICIT or OK.

Read-only — no writes, no `mc` commands sent. Pure aggregation.

Usage
-----
    scripts/base-inventory.py                 # human-readable table
    scripts/base-inventory.py --json          # machine-readable
    scripts/base-inventory.py --suggest-cards # prints [SUPPLY] card draft for each deficit

Bot endpoints checked: 3001..3005 (gatherer/flint/mason/barley/steward).
If a bot is down, its chest snapshots are skipped — others still contribute.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
GOALS_YAML = DATA_DIR / "base-goals.yaml"
BOT_PORTS = {
    "gatherer": 3001,
    "flint":    3002,
    "mason":    3003,
    "barley":   3004,
    "steward":  3005,
}
MARK_PREFIX = "chest_"


def parse_yaml(path: Path) -> dict:
    """Tiny YAML reader for our flat schema (avoids PyYAML dep)."""
    out: dict = {}
    current: dict | None = None
    current_key: str | None = None
    for raw in path.read_text().splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" ") and line.endswith(":"):
            current_key = line[:-1].strip()
            current = {}
            out[current_key] = current
            continue
        if line.startswith("  ") and current is not None and ":" in line:
            k, v = line.strip().split(":", 1)
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                items = [x.strip() for x in v[1:-1].split(",") if x.strip()]
                current[k.strip()] = items
            else:
                try:
                    current[k.strip()] = int(v)
                except ValueError:
                    current[k.strip()] = v
    return out


def load_chest_marks() -> dict[str, dict]:
    """Aggregate all chest_<name> marks across every bot's locations file.

    Returns: { mark_name: { coord: [x,y,z], owner_bot: str, ... } }
    Duplicates (same mark name across bots) — last writer wins; coord
    mismatch is logged to stderr.
    """
    marks: dict[str, dict] = {}
    for path in glob.glob(str(DATA_DIR / "locations-*.json")):
        owner = Path(path).stem.replace("locations-", "")
        try:
            with open(path) as fh:
                locs = json.load(fh)
        except Exception:
            continue
        for name, entry in locs.items():
            if not isinstance(entry, dict):
                continue
            if not name.startswith(MARK_PREFIX):
                continue
            coord = [entry.get("x"), entry.get("y"), entry.get("z")]
            if any(c is None for c in coord):
                continue
            if name in marks:
                prev = marks[name]["coord"]
                if prev != coord:
                    print(f"  [warn] mark {name} coord mismatch: "
                          f"{marks[name]['owner_bot']} says {prev}, "
                          f"{owner} says {coord}", file=sys.stderr)
            marks[name] = {"coord": coord, "owner_bot": owner,
                           "saved": entry.get("saved")}
    return marks


def fetch_chest_snapshots(port: int, timeout: float = 1.5) -> dict:
    """Fetch a bot's /state response and extract chestSnapshots map."""
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/state", timeout=timeout,
        ) as r:
            data = json.loads(r.read())
            return data.get("goals", {}).get("chestSnapshots", {}) or {}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return {}


def coord_key(coord: list[int]) -> str:
    """chestSnapshots uses 'x,y,z' string keys."""
    return f"{int(coord[0])},{int(coord[1])},{int(coord[2])}"


def snapshot_for_coord(snapshots: dict, coord: list[int]):
    """Find a snapshot for this coord, also tolerating mark-name keys."""
    key = coord_key(coord)
    if key in snapshots:
        return snapshots[key]
    # Fall back to scanning by position
    for k, snap in snapshots.items():
        pos = snap.get("position") or {}
        if (int(pos.get("x", -9999)) == int(coord[0])
                and int(pos.get("y", -9999)) == int(coord[1])
                and int(pos.get("z", -9999)) == int(coord[2])):
            return snap
    return None


def aggregate(goals: dict, chest_marks: dict[str, dict]) -> dict:
    """Walk every live bot, collect chest snapshots for each registered
    chest, sum items into goal categories."""
    # Fetch each live bot's snapshots once
    all_snaps: dict[str, dict] = {}
    for name, port in BOT_PORTS.items():
        all_snaps[name] = fetch_chest_snapshots(port)

    # Build per-mark item lists by collapsing across bot snapshots (newest wins)
    chest_data: dict[str, dict] = {}
    for mark_name, mark in chest_marks.items():
        best_snap = None
        best_ts = ""
        for bot, snaps in all_snaps.items():
            snap = snapshot_for_coord(snaps, mark["coord"])
            if snap is None:
                continue
            ts = snap.get("at", "")
            if ts > best_ts:
                best_ts = ts
                best_snap = snap
        chest_data[mark_name] = {
            "coord": mark["coord"],
            "snapshot_at": best_ts,
            "items": (best_snap or {}).get("items", []) if best_snap else None,
            "fresh": bool(best_snap),
        }

    # Sum by goal category
    totals: dict[str, int] = {cat: 0 for cat in goals}
    for cat, spec in goals.items():
        wanted = set(spec.get("items", []))
        for ch in chest_data.values():
            for item in (ch["items"] or []):
                if item.get("name") in wanted:
                    totals[cat] += int(item.get("count", 0))

    return {"totals": totals, "chests": chest_data, "goals": goals}


def fmt_age(ts: str) -> str:
    if not ts:
        return "—"
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - dt
        s = int(delta.total_seconds())
        if s < 60: return f"{s}s ago"
        if s < 3600: return f"{s//60}m ago"
        return f"{s//3600}h ago"
    except Exception:
        return ts[:19]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--suggest-cards", action="store_true",
                    help="Print [SUPPLY] card drafts for deficits")
    args = ap.parse_args()

    if not GOALS_YAML.is_file():
        sys.exit(f"missing {GOALS_YAML}")
    goals = parse_yaml(GOALS_YAML)
    chest_marks = load_chest_marks()

    if not chest_marks:
        if args.json:
            print(json.dumps({"error": "no chest_* marks registered",
                              "hint": "have a bot run mc mark chest_<purpose>"}))
            return
        print("⚠ no chest_* marks registered. Have a bot run:")
        print("    mc mark chest_food      # at the food chest")
        print("    mc mark chest_wood      # at the log chest")
        print("    mc mark chest_stone     # at the stone chest")
        print("    mc mark chest_coal      # at the fuel chest")
        print("Then re-run this script. See data/base-goals.yaml for resource categories.")
        return

    result = aggregate(goals, chest_marks)

    if args.json:
        print(json.dumps(result, indent=2, default=str))
        return

    # Human table
    print(f"# base inventory  ({len(chest_marks)} chest(s) registered, "
          f"goals={GOALS_YAML.name})")
    print("# resource    current/min   status      categories satisfied via items")
    deficits = []
    for cat, spec in goals.items():
        cur = result["totals"][cat]
        tmin = spec["target_min"]
        tok  = spec["target_ok"]
        if cur >= tok:
            status = "✓ ok"
        elif cur >= tmin:
            status = "~ low"
        else:
            status = f"⚠ DEFICIT (-{tmin - cur})"
            deficits.append((cat, spec, cur))
        print(f"  {cat:<10}  {cur:>5}/{tmin:<5}  {status}")

    print(f"\n# chests scanned")
    for name, ch in sorted(chest_marks.items()):
        snap = result["chests"][name]
        age = fmt_age(snap["snapshot_at"])
        n = len(snap["items"]) if snap["items"] else 0
        if not snap["fresh"]:
            print(f"  {name:<22} ({ch['coord']})  no snapshot — open it with mc list_container")
        else:
            print(f"  {name:<22} ({ch['coord']})  {n} stacks, snapshot {age}")

    if args.suggest_cards and deficits:
        print("\n# suggested [SUPPLY] cards (file via hermes kanban create)")
        for cat, spec, cur in deficits:
            assignee = spec.get("assignee", "flint")
            need = spec["target_ok"] - cur
            items_csv = ",".join(spec["items"][:4]) + ("..." if len(spec["items"]) > 4 else "")
            tmin = spec["target_min"]
            tok  = spec["target_ok"]
            body = (f"Base {cat} below target. Current={cur}, target_min={tmin}, "
                    f"target_ok={tok}. Need ~{need} more across items: {items_csv}. "
                    f"Deposit in the chest marked chest_{cat} (or chest_misc if no "
                    f"dedicated chest).")
            title = f"[SUPPLY] Base {cat} deficit (-{need} below target_ok)"
            print(f"  hermes kanban --board landfolk-ops create \\")
            print(f"    --assignee {assignee} --priority 80 \\")
            print(f"    --body {body!r} \\")
            print(f"    {title!r}")


if __name__ == "__main__":
    main()
