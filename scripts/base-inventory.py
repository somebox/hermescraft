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
# Genesis-v2 body pool — distinct ports from the prod/landfolk set above. Without
# this, genesis runs would miss Mox:3007 + Zee:3006 and mislabel Pip:3005.
GENESIS_POOL = {
    "mox": 3007,
    "pip": 3005,
    "zee": 3006,
}
# Genesis SUPPLY-card routing: which expertise restocks each resource category.
GENESIS_ASSIGNEE = {
    "food":  "colony-gatherer",
    "wood":  "colony-gatherer",
    "stone": "colony-miner",
    "coal":  "colony-miner",
}
MARK_PREFIX = "chest_"


def ports_for_pool(pool: str) -> dict:
    return GENESIS_POOL if pool in ("genesis-v2", "genesis") else BOT_PORTS


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


SHARED_LOCATIONS_FILE = DATA_DIR / "locations-base.json"


def load_chest_marks() -> dict[str, dict]:
    """Aggregate all chest_<name> marks across every bot's locations file.

    Returns: { mark_name: { coord: [x,y,z], owner_bot: str, ... } }

    Mirrors bot/lib/runtime/locations.js → mergeMarks: shared
    (locations-base.json) wins for fleet-prefix names. Private writes are
    proposals and surface as `(shadowed)` info — never as conflict warnings,
    since shared is the canonical source.
    """
    # 1) Load shared (steward-owned) entries first; they're authoritative.
    marks: dict[str, dict] = {}
    try:
        with open(SHARED_LOCATIONS_FILE) as fh:
            shared = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        shared = {}
    if isinstance(shared, dict):
        for name, entry in shared.items():
            if not isinstance(entry, dict) or not name.startswith(MARK_PREFIX):
                continue
            coord = [entry.get("x"), entry.get("y"), entry.get("z")]
            if any(c is None for c in coord):
                continue
            marks[name] = {"coord": coord, "owner_bot": "base",
                           "saved": entry.get("saved"), "source": "shared"}

    # 2) Per-bot files fill in names not in shared. Conflicts among private
    # files are still warned about; private-vs-shared differences are not.
    for path in sorted(glob.glob(str(DATA_DIR / "locations-*.json"))):
        if Path(path).name == "locations-base.json":
            continue
        owner = Path(path).stem.replace("locations-", "")
        try:
            with open(path) as fh:
                locs = json.load(fh)
        except Exception:
            continue
        for name, entry in locs.items():
            if not isinstance(entry, dict) or not name.startswith(MARK_PREFIX):
                continue
            coord = [entry.get("x"), entry.get("y"), entry.get("z")]
            if any(c is None for c in coord):
                continue
            existing = marks.get(name)
            if existing and existing.get("source") == "shared":
                # Shadowed by shared — no warning, but record the proposal
                # for visibility in audit modes (future use).
                continue
            if existing and existing["coord"] != coord:
                print(f"  [warn] mark {name} coord mismatch: "
                      f"{existing['owner_bot']} says {existing['coord']}, "
                      f"{owner} says {coord} — run scripts/reconcile-marks.py",
                      file=sys.stderr)
            marks[name] = {"coord": coord, "owner_bot": owner,
                           "saved": entry.get("saved"), "source": "private"}
    return marks


def fetch_chest_snapshots(port: int, timeout: float = 1.5) -> dict:
    """Fetch a bot's /marks endpoint and synthesize a snapshot lookup map.

    Each /marks entry already merges the chestSnapshots map server-side
    (see buildMarksList in bot/lib/runtime/locations.js — line that does
    `chestSnapshots[name] ?? chestSnapshots[key]`). We index by both mark
    name and coord string so snapshot_for_coord's existing lookup chain
    works without changes.
    """
    snaps: dict = {}
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/marks", timeout=timeout,
        ) as r:
            data = json.loads(r.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return snaps
    marks = (data.get("data") or {}).get("marks") or []
    for m in marks:
        chest = m.get("chest_snapshot")
        if not chest:
            continue
        # Ensure each snapshot carries a position so snapshot_for_coord's
        # tolerance scan can match by coord even if mark names disagree.
        pos = chest.get("position") or {
            "x": m.get("x"), "y": m.get("y"), "z": m.get("z"),
        }
        synthesized = {**chest, "position": pos}
        if m.get("name"):
            snaps[m["name"]] = synthesized
        if all(v is not None for v in (pos.get("x"), pos.get("y"), pos.get("z"))):
            snaps[f"{int(pos['x'])},{int(pos['y'])},{int(pos['z'])}"] = synthesized
    return snaps


def load_render_snapshots() -> dict:
    """Render-provided starter-provision snapshots (genesis): chest_food pre-stocked
    at shelter render so the P2 food gate sees the pantry without a worker opening
    the chest (/marks serves in-memory only). Indexed by name + coord like
    fetch_chest_snapshots; a newer live snapshot supersedes it in aggregate()."""
    f = DATA_DIR / "chest-snapshots-render.json"
    try:
        data = json.loads(f.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict = {}
    if isinstance(data, dict):
        for name, snap in data.items():
            if not isinstance(snap, dict):
                continue
            pos = snap.get("position") or {}
            s = {**snap, "position": pos}
            out[name] = s
            if all(pos.get(k) is not None for k in ("x", "y", "z")):
                out[f"{int(pos['x'])},{int(pos['y'])},{int(pos['z'])}"] = s
    return out


def coord_key(coord: list[int]) -> str:
    """chestSnapshots uses 'x,y,z' string keys."""
    return f"{int(coord[0])},{int(coord[1])},{int(coord[2])}"


def snapshot_for_coord(snapshots: dict, coord: list[int], mark_name: str | None = None,
                       xz_tolerance: int = 2, y_tolerance: int = 1):
    """Find a snapshot for this mark/coord, tolerating two common offsets.

    Lookup order:
      1. By mark name. server.js' snapshotChestAtPosition keys snapshots by
         mark name whenever a mark matches the chest position, so this is
         the canonical path once the shared marks file is reconciled.
      2. By exact coord-string key (back-compat for older snapshots written
         before a mark existed for that position).
      3. Position scan with tolerance. Mark coords and actual chest-block
         coords often differ by 1-2 blocks (the mark records where the bot
         was standing when set; the block is one of the adjacent cells).
         Box matches findNearbyContainer in bot/lib/runtime/locations.js
         (xz ±2, y ±1). Closest match wins on Manhattan distance.
    """
    if mark_name and mark_name in snapshots:
        return snapshots[mark_name]
    key = coord_key(coord)
    if key in snapshots:
        return snapshots[key]
    cx, cy, cz = int(coord[0]), int(coord[1]), int(coord[2])
    candidates = []
    for _k, snap in snapshots.items():
        pos = snap.get("position") or {}
        try:
            sx, sy, sz = int(pos.get("x")), int(pos.get("y")), int(pos.get("z"))
        except (TypeError, ValueError):
            continue
        dx, dy, dz = abs(sx - cx), abs(sy - cy), abs(sz - cz)
        if dx <= xz_tolerance and dy <= y_tolerance and dz <= xz_tolerance:
            candidates.append((dx + dy + dz, snap))
    if not candidates:
        return None
    candidates.sort(key=lambda t: t[0])
    return candidates[0][1]


def aggregate(goals: dict, chest_marks: dict[str, dict], ports: dict | None = None) -> dict:
    """Walk every live bot in `ports` (default prod BOT_PORTS), collect chest
    snapshots for each registered chest, sum items into goal categories."""
    ports = ports if ports is not None else BOT_PORTS
    # Fetch each live bot's snapshots once
    all_snaps: dict[str, dict] = {}
    for name, port in ports.items():
        all_snaps[name] = fetch_chest_snapshots(port)
    # Render-provided starter pantry (genesis): counts until a live snapshot of the
    # same chest (newer `at`) supersedes it, so real depletion still shows.
    render = load_render_snapshots()
    if render:
        all_snaps["render"] = render

    # Build per-mark item lists by collapsing across bot snapshots (newest wins)
    chest_data: dict[str, dict] = {}
    for mark_name, mark in chest_marks.items():
        best_snap = None
        best_ts = ""
        for bot, snaps in all_snaps.items():
            snap = snapshot_for_coord(snaps, mark["coord"], mark_name=mark_name)
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


def compute_deficits(pool: str = "prod") -> dict:
    """Typed deficits for `pool` ('genesis-v2' or 'prod') — for the poller to
    consume DIRECTLY (no human-text parsing). Returns:
      {ok, pool, totals, chests_total, chests_fresh,
       deficits: [{resource, current, target_min, target_ok, deficit, assignee, items}]}
    `assignee` is genesis expertise (gatherer/miner) for the genesis pool, else the
    goal's prod assignee. A resource is a deficit when current < target_min."""
    if not GOALS_YAML.is_file():
        return {"ok": False, "error": f"missing {GOALS_YAML}"}
    goals = parse_yaml(GOALS_YAML)
    chest_marks = load_chest_marks()
    result = aggregate(goals, chest_marks, ports=ports_for_pool(pool))
    genesis = pool in ("genesis-v2", "genesis")
    deficits = []
    for cat, spec in goals.items():
        cur = int(result["totals"].get(cat, 0))
        tmin = int(spec.get("target_min", 0))
        if cur < tmin:
            assignee = (GENESIS_ASSIGNEE.get(cat, "colony-gatherer") if genesis
                        else spec.get("assignee", "flint"))
            deficits.append({
                "resource": cat, "current": cur, "target_min": tmin,
                "target_ok": int(spec.get("target_ok", tmin)), "deficit": tmin - cur,
                "assignee": assignee, "items": spec.get("items", []),
            })
    fresh = sum(1 for ch in result["chests"].values() if ch.get("fresh"))
    return {"ok": True, "pool": pool, "totals": result["totals"],
            "chests_total": len(chest_marks), "chests_fresh": fresh, "deficits": deficits}


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
    ap.add_argument("--pool", default="prod",
                    help="body pool to scan: 'prod' (default, ports 3001-3005) or 'genesis-v2' (Mox/Pip/Zee)")
    ap.add_argument("--suggest-cards", action="store_true",
                    help="Print [SUPPLY] card drafts for deficits (human text)")
    ap.add_argument("--suggest-json", action="store_true",
                    help="Print typed deficits as JSON for the poller (genesis assignees with --pool genesis-v2)")
    args = ap.parse_args()

    if args.suggest_json:
        print(json.dumps(compute_deficits(args.pool), indent=2, default=str))
        return

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

    result = aggregate(goals, chest_marks, ports=ports_for_pool(args.pool))

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
