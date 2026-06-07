#!/usr/bin/env python3
"""Runner for the two-bot cooperative-base demo.

Four modes, all driven by --run-id:

    --dry-run         Print the 10 invocations as shell-quoted commands.
                      No creates, no manifest. Useful for graph + author
                      verification.

    --create-only     Create the 10 cards via hermes kanban create in
                      topological order. Write data/postmortems/two-bot-
                      base/<run-id>/manifest.json with slug → card id +
                      assignee + bot tag + created_at. Exit. Operator
                      runs --watch separately, or runs --evaluate-only
                      after the cards have terminated.

    --watch           Load manifest.json, poll the proto tenant via
                      `hermes kanban list --tenant proto-agent-arch
                      --json` (falls back to SQLite query if --json
                      unavailable). Emit a card_terminal telemetry
                      event on each status transition. Exit when all
                      cards have reached a terminal state (done or
                      blocked) or after --watch-timeout.

    --evaluate-only   Load manifest.json. Query the board for final
                      statuses. Run `mc verify at_mark seed --block
                      oak_sign` on Tester :3004 (configurable via
                      MC_TESTER_URL env). Compute the three scorecard
                      numbers (parallelism_observed + overlap_s,
                      pip_done_count + zee_done_count, sign_at_seed).
                      Write scorecard.json next to manifest.json. Safe
                      to re-run at any time.

A typical flow:

    HERMES_HOME=~/.hermes-proto-agent-arch \\
      python run_two_bot_base.py --run-id trial-$(date +%s) --watch

is shorthand for: --create-only first, then --watch, then
--evaluate-only at the end.

Plan: ~/.claude/plans/create-a-plan-that-magical-lovelace.md
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))  # so `capstone.*` imports work

from capstone.author import (  # noqa: E402
    DEFAULT_MAX_RUNTIME,
    DEFAULT_TENANT,
    author_colony_lane,
    resolve_parents,
)
from capstone.acceptance import evaluate  # noqa: E402
from capstone.two_bot_base_graph import (  # noqa: E402
    PIP_LANE_SLUGS,
    ZEE_LANE_SLUGS,
    build_default_graph,
)


REPO_ROOT = _HERE.parent.parent.parent
POSTMORTEMS_DIR = REPO_ROOT / "data" / "postmortems" / "two-bot-base"
DEFAULT_TESTER_URL = "http://127.0.0.1:3004"


# ── Telemetry shim — minimal JSONL emitter ─────────────────────────

class TelemetryWriter:
    """Append-only JSONL writer. SUMMARY_FIELDS stay stable; new event
    kinds (card_terminal, scorecard) are additive only."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, kind: str, **payload) -> None:
        event = {"kind": kind, "at": int(time.time()), **payload}
        with self.path.open("a") as f:
            f.write(json.dumps(event) + "\n")


# ── Subprocess helpers ─────────────────────────────────────────────

def _hermes_env() -> dict:
    """Ensure HERMES_HOME is set for any `hermes` subprocess."""
    env = dict(os.environ)
    env.setdefault(
        "HERMES_HOME", os.path.expanduser("~/.hermes-proto-agent-arch"),
    )
    return env


def _run_hermes_create(cmd: tuple[str, ...]) -> Optional[str]:
    """Shell `hermes kanban create …`, return the card id or None."""
    proc = subprocess.run(cmd, env=_hermes_env(), capture_output=True, text=True)
    if proc.returncode != 0:
        print(
            f"[runner] hermes create failed (exit {proc.returncode}):"
            f"\n  cmd: {' '.join(shlex.quote(p) for p in cmd)}"
            f"\n  stderr: {proc.stderr.strip()}",
            file=sys.stderr,
        )
        return None
    try:
        payload = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        print(
            f"[runner] hermes create returned non-JSON: {proc.stdout!r}",
            file=sys.stderr,
        )
        return None
    return payload.get("id") or payload.get("task_id") or payload.get("uuid")


# ── Board introspection ────────────────────────────────────────────

def _hermes_home() -> Path:
    return Path(_hermes_env()["HERMES_HOME"])


def _kanban_db() -> Path:
    return _hermes_home() / "kanban.db"


def query_board_statuses(card_ids: list[str]) -> dict[str, str]:
    """Return {card_id: status} for each id, via SQLite (proto-native).

    Defaulting to SQLite — the plan notes that `hermes kanban events
    --json` isn't guaranteed in every Hermes version, and `kanban list`
    is mostly redundant when we already know the card ids.
    """
    if not card_ids:
        return {}
    db_path = _kanban_db()
    if not db_path.exists():
        print(f"[runner] kanban.db missing at {db_path}", file=sys.stderr)
        return {}
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        placeholders = ",".join("?" * len(card_ids))
        rows = conn.execute(
            f"SELECT id, status FROM tasks WHERE id IN ({placeholders})",
            card_ids,
        ).fetchall()
    finally:
        conn.close()
    return {r["id"]: r["status"] for r in rows}


def query_running_intervals(card_ids: list[str]) -> dict[str, list[tuple[int, Optional[int]]]]:
    """For each id, return list of (started_at, ended_at) intervals
    when the card was in `running` status. ended_at=None means still
    running. Used to compute parallelism_observed."""
    if not card_ids:
        return {}
    db_path = _kanban_db()
    if not db_path.exists():
        return {}
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        placeholders = ",".join("?" * len(card_ids))
        rows = conn.execute(
            f"""
            SELECT task_id, kind, created_at
            FROM task_events
            WHERE task_id IN ({placeholders})
              AND kind IN ('claimed', 'running', 'completed', 'blocked', 'released', 'done')
            ORDER BY task_id, created_at
            """,
            card_ids,
        ).fetchall()
    finally:
        conn.close()

    intervals: dict[str, list[tuple[int, Optional[int]]]] = {cid: [] for cid in card_ids}
    open_starts: dict[str, int] = {}
    for r in rows:
        tid = r["task_id"]
        kind = r["kind"]
        at = r["created_at"]
        if kind in ("claimed", "running") and tid not in open_starts:
            open_starts[tid] = at
        elif kind in ("completed", "done", "blocked", "released") and tid in open_starts:
            intervals[tid].append((open_starts.pop(tid), at))
    for tid, start in open_starts.items():
        intervals[tid].append((start, None))
    return intervals


def overlap_seconds(
    pip_intervals: list[tuple[int, Optional[int]]],
    zee_intervals: list[tuple[int, Optional[int]]],
) -> int:
    """Total seconds where any pip interval overlaps any zee interval."""
    total = 0
    for ps, pe in pip_intervals:
        pe_eff = pe if pe is not None else int(time.time())
        for zs, ze in zee_intervals:
            ze_eff = ze if ze is not None else int(time.time())
            start = max(ps, zs)
            end = min(pe_eff, ze_eff)
            if end > start:
                total += end - start
    return total


# ── Mode implementations ───────────────────────────────────────────

def mode_dry_run(board: Optional[str] = None) -> int:
    graph = build_default_graph()
    invocations = author_colony_lane(graph, board=board)
    print(f"[runner] dry-run: {len(invocations)} invocations  (board={board or '(proto/default)'})")
    for inv in invocations:
        print(f"  {inv.slug}: {' '.join(shlex.quote(p) for p in inv.cmd)}")
        if inv.depends_on_slugs:
            print(f"    depends_on: {', '.join(inv.depends_on_slugs)}")
    return 0


def mode_create_only(run_id: str, board: Optional[str] = None) -> int:
    graph = build_default_graph()
    invocations = author_colony_lane(graph, board=board)

    trial_dir = POSTMORTEMS_DIR / run_id
    trial_dir.mkdir(parents=True, exist_ok=True)
    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("run_started", run_id=run_id, mode="create-only",
                   tenant=DEFAULT_TENANT)

    slug_to_id: dict[str, str] = {}
    manifest_cards: list[dict] = []
    for inv in invocations:
        cmd = resolve_parents(inv, slug_to_id)
        card_id = _run_hermes_create(cmd)
        if card_id is None:
            telemetry.emit("create_failed", slug=inv.slug)
            print(f"[runner] failed at {inv.slug}; manifest partial", file=sys.stderr)
            break
        slug_to_id[inv.slug] = card_id
        # Identify bot from the title prefix.
        bot = "?"
        if inv.title.lower().startswith("[bot:"):
            bot = inv.title.split("]", 1)[0][len("[bot:"):].strip().lower()
        assignee_idx = inv.cmd.index("--assignee") + 1
        manifest_cards.append({
            "slug": inv.slug,
            "card_id": card_id,
            "assignee": inv.cmd[assignee_idx],
            "bot": bot,
            "title": inv.title,
            "depends_on_slugs": list(inv.depends_on_slugs),
            "created_at": int(time.time()),
        })
        telemetry.emit("card_created", slug=inv.slug, card_id=card_id,
                       assignee=inv.cmd[assignee_idx], bot=bot)
        print(f"[runner] {inv.slug} → {card_id}")

    manifest = {
        "run_id": run_id,
        "tenant": DEFAULT_TENANT,
        "board": board,
        "cards": manifest_cards,
        "acceptance_predicate": graph.acceptance_predicate,
        "pip_lane": list(PIP_LANE_SLUGS),
        "zee_lane": list(ZEE_LANE_SLUGS),
    }
    (trial_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"[runner] manifest written: {trial_dir / 'manifest.json'}")
    return 0 if len(manifest_cards) == len(invocations) else 1


def mode_watch(run_id: str, watch_timeout_s: int = 7200,
               poll_interval_s: int = 10) -> int:
    trial_dir = POSTMORTEMS_DIR / run_id
    manifest_path = trial_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"[runner] no manifest at {manifest_path}; run --create-only first",
              file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text())
    card_ids = [c["card_id"] for c in manifest["cards"]]
    slug_by_id = {c["card_id"]: c["slug"] for c in manifest["cards"]}
    bot_by_id = {c["card_id"]: c["bot"] for c in manifest["cards"]}

    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("watch_started", run_id=run_id, watch_timeout_s=watch_timeout_s)

    last_status: dict[str, str] = {}
    started_at = int(time.time())
    while True:
        statuses = query_board_statuses(card_ids)
        for cid, status in statuses.items():
            prev = last_status.get(cid)
            if prev != status:
                slug = slug_by_id.get(cid, cid)
                bot = bot_by_id.get(cid, "?")
                telemetry.emit("card_terminal" if status in ("done", "blocked", "archived")
                               else "card_transition",
                               slug=slug, card_id=cid, bot=bot,
                               from_status=prev, to_status=status)
                print(f"  [t+{int(time.time()) - started_at}s] {slug} ({bot}): "
                      f"{prev or '-'} → {status}")
                last_status[cid] = status

        # Exit when every card is terminal.
        terminal = {"done", "blocked", "archived"}
        if statuses and all(s in terminal for s in statuses.values()):
            telemetry.emit("watch_finished", reason="all_terminal")
            print(f"[runner] all cards terminal; watch done at "
                  f"t+{int(time.time()) - started_at}s")
            return 0

        if int(time.time()) - started_at > watch_timeout_s:
            telemetry.emit("watch_finished", reason="timeout")
            print(f"[runner] watch timed out after {watch_timeout_s}s", file=sys.stderr)
            return 1

        time.sleep(poll_interval_s)


def mode_evaluate_only(run_id: str) -> int:
    trial_dir = POSTMORTEMS_DIR / run_id
    manifest_path = trial_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"[runner] no manifest at {manifest_path}", file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text())
    cards = manifest["cards"]
    card_ids = [c["card_id"] for c in cards]
    pip_slugs = set(manifest["pip_lane"])
    zee_slugs = set(manifest["zee_lane"])

    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("evaluate_started", run_id=run_id)

    statuses = query_board_statuses(card_ids)
    pip_done = sum(1 for c in cards
                   if c["slug"] in pip_slugs and statuses.get(c["card_id"]) == "done")
    zee_done = sum(1 for c in cards
                   if c["slug"] in zee_slugs and statuses.get(c["card_id"]) == "done")

    # Parallelism — running intervals overlap?
    pip_ids = [c["card_id"] for c in cards if c["bot"] == "pip"]
    zee_ids = [c["card_id"] for c in cards if c["bot"] == "zee"]
    intervals = query_running_intervals(card_ids)
    pip_intervals: list[tuple[int, Optional[int]]] = []
    for cid in pip_ids:
        pip_intervals.extend(intervals.get(cid, []))
    zee_intervals: list[tuple[int, Optional[int]]] = []
    for cid in zee_ids:
        zee_intervals.extend(intervals.get(cid, []))
    overlap_s = overlap_seconds(pip_intervals, zee_intervals)
    parallelism_observed = overlap_s > 0

    # Final acceptance: at_mark seed --block oak_sign on Tester.
    tester_url = os.environ.get("MC_TESTER_URL", DEFAULT_TESTER_URL)
    predicate = manifest.get("acceptance_predicate") or {
        "kind": "at_mark", "mark": "seed", "block": "oak_sign",
    }
    try:
        result = evaluate(predicate, tester_url=tester_url)
        sign_at_seed = result.satisfied
        sign_evaluable = result.evaluable
        sign_detail = result.detail
    except Exception as e:  # noqa: BLE001 — surface the error in the scorecard
        sign_at_seed = False
        sign_evaluable = False
        sign_detail = {"error": str(e)}

    if parallelism_observed and sign_at_seed:
        band = "pass"
    elif parallelism_observed or (pip_done + zee_done) > 0:
        band = "partial"
    else:
        band = "fail"

    scorecard = {
        "run_id": run_id,
        "band": band,
        "parallelism_observed": parallelism_observed,
        "overlap_s": overlap_s,
        "pip_done_count": pip_done,
        "pip_lane_total": len(pip_slugs),
        "zee_done_count": zee_done,
        "zee_lane_total": len(zee_slugs),
        "sign_at_seed": sign_at_seed,
        "sign_evaluable": sign_evaluable,
        "sign_detail": sign_detail,
        "card_statuses": {c["slug"]: statuses.get(c["card_id"], "?") for c in cards},
    }
    (trial_dir / "scorecard.json").write_text(json.dumps(scorecard, indent=2))
    telemetry.emit("scorecard", **scorecard)

    print(f"[runner] scorecard: band={band}, parallelism={parallelism_observed} "
          f"(overlap={overlap_s}s), pip={pip_done}/{len(pip_slugs)}, "
          f"zee={zee_done}/{len(zee_slugs)}, sign={sign_at_seed}")
    return 0


# ── Entry point ────────────────────────────────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=False,
                        help="trial id (required for non-dry-run modes)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--create-only", action="store_true")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--evaluate-only", action="store_true")
    parser.add_argument("--watch-timeout", type=int, default=7200,
                        help="watch mode: give up after N seconds (default 7200)")
    parser.add_argument("--poll-interval", type=int, default=10,
                        help="watch mode: poll every N seconds (default 10)")
    parser.add_argument("--board", default=None,
                        help="kanban board name. None = proto-rig default "
                             "(flat workspaces). Set to a name (e.g. "
                             "'two-bot-demo') to land cards on a "
                             "filesystem-isolated board under "
                             "HERMES_HOME/kanban/boards/<name>/, visible "
                             "to the live :9119 dashboard.")
    args = parser.parse_args(argv)

    if args.dry_run:
        return mode_dry_run(board=args.board)

    if not args.run_id:
        parser.error("--run-id required for non-dry-run modes")
    run_id = args.run_id

    if args.create_only:
        return mode_create_only(run_id, board=args.board)
    if args.watch:
        # Watch implies create-only first if no manifest exists; otherwise
        # just watch.
        manifest = POSTMORTEMS_DIR / run_id / "manifest.json"
        if not manifest.exists():
            rc = mode_create_only(run_id, board=args.board)
            if rc != 0:
                return rc
        return mode_watch(run_id, args.watch_timeout, args.poll_interval)
    if args.evaluate_only:
        return mode_evaluate_only(run_id)

    parser.error("pick one mode: --dry-run | --create-only | --watch | --evaluate-only")
    return 64  # unreachable


if __name__ == "__main__":
    sys.exit(main())
