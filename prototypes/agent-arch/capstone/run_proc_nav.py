#!/usr/bin/env python3
"""Proc-nav kanban runner (fork of run_wheat_capstone modes).

Board: proc-nav-lab. Graphs: proc-scout | proc-scout-stress | proc-scout-road.
Postmortems: data/postmortems/proc-nav-lab/<RUN_ID>/.
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
import urllib.request
from pathlib import Path
from typing import Optional

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from capstone.acceptance import evaluate_all  # noqa: E402
from capstone.author import (  # noqa: E402
    DEFAULT_TENANT,
    author_colony_lane,
    resolve_parents,
)
from capstone.graph_loader import GRAPH_NAMES, load_graph  # noqa: E402
from capstone.predicates import resolve_for_evaluate  # noqa: E402
from capstone.proc_nav_helpers import (  # noqa: E402
    acceptance_predicates_from_map,
    count_mc_verbs_from_text,
    load_map_card,
    load_thresholds,
    merge_verb_counts,
    tier_from_graph,
)
from capstone.render_proc_nav_spatial_map import render_spatial_map_html  # noqa: E402
from capstone.wheat_graph import EPIC_BOT  # noqa: E402

REPO_ROOT = _HERE.parent.parent.parent
POSTMORTEMS_DIR = REPO_ROOT / "data" / "postmortems" / "proc-nav-lab"
DEFAULT_BOARD = "proc-nav-lab"
DEFAULT_TESTER_URL = "http://127.0.0.1:3004"
DEFAULT_MOX_URL = "http://127.0.0.1:3007"
PROC_NAV_GRAPHS = frozenset({"proc-scout", "proc-scout-stress", "proc-scout-road"})


class TelemetryWriter:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, kind: str, **payload) -> None:
        event = {"kind": kind, "at": int(time.time()), **payload}
        with self.path.open("a") as f:
            f.write(json.dumps(event) + "\n")


def _hermes_env() -> dict:
    env = dict(os.environ)
    env.setdefault("HERMES_HOME", os.path.expanduser("~/.hermes"))
    return env


_BOARD: Optional[str] = None


def _kanban_db() -> Path:
    home = Path(_hermes_env()["HERMES_HOME"])
    if _BOARD:
        path = home / "kanban" / "boards" / _BOARD / "kanban.db"
        if path.exists():
            return path
    return home / "kanban.db"


def _ensure_board_exists(board: str) -> bool:
    proc = subprocess.run(
        ["hermes", "kanban", "boards", "create", board],
        env=_hermes_env(),
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def _run_hermes_create(cmd: tuple[str, ...]) -> Optional[str]:
    proc = subprocess.run(cmd, env=_hermes_env(), capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"[proc-nav] create failed: {proc.stderr.strip()}", file=sys.stderr)
        return None
    try:
        payload = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return None
    return payload.get("id") or payload.get("task_id") or payload.get("uuid")


def query_board_statuses(card_ids: list[str]) -> dict[str, str]:
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
            f"SELECT id, status FROM tasks WHERE id IN ({placeholders})",
            card_ids,
        ).fetchall()
    finally:
        conn.close()
    return {r["id"]: r["status"] for r in rows}


def _assignee_from_cmd(cmd: tuple[str, ...]) -> str:
    return cmd[cmd.index("--assignee") + 1]


def _map_seed_from_env(run_id: str) -> str:
    return os.environ.get("PROC_NAV_MAP_SEED") or os.environ.get("TRY_SEED") or run_id


def _poll_mox_position(mox_url: str) -> Optional[dict]:
    try:
        with urllib.request.urlopen(f"{mox_url.rstrip('/')}/status", timeout=5) as resp:
            data = json.loads(resp.read().decode())
        pos = (data.get("data") or {}).get("position") or data.get("position")
        if isinstance(pos, dict) and "x" in pos:
            return pos
    except Exception:
        return None
    return None


def _session_corpus_for_card(kanban_db: Path, task_id: str) -> str:
    if not kanban_db.exists():
        return ""
    conn = sqlite3.connect(str(kanban_db))
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT metadata FROM task_runs
            WHERE task_id=? AND outcome='completed'
            ORDER BY started_at DESC LIMIT 1
            """,
            (task_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not row["metadata"]:
        return ""
    meta = json.loads(row["metadata"])
    sid = meta.get("worker_session_id")
    if not sid:
        return json.dumps(meta)
    home = Path(_hermes_env()["HERMES_HOME"])
    for role in (
        "navigator",
        "navigator-pip",
        "planner",
        "builder",
        "builder-mox",
        "farmer",
        "crafter",
    ):
        db = home / "profiles" / role / "state.db"
        if not db.is_file():
            continue
        conn = sqlite3.connect(str(db))
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT content, tool_calls, reasoning FROM messages
                WHERE session_id=? ORDER BY id
                """,
                (sid,),
            ).fetchall()
        finally:
            conn.close()
        if rows:
            return "\n".join(
                str(r[c] or "") for r in rows for c in ("content", "tool_calls", "reasoning")
            )
    return json.dumps(meta)


def mode_dry_run(board: Optional[str], graph_name: str) -> int:
    graph = load_graph(graph_name, repo_root=REPO_ROOT)
    invocations = author_colony_lane(graph, epic_bot=EPIC_BOT, board=board)
    print(f"[proc-nav] dry-run: {len(invocations)} cards graph={graph_name}")
    for inv in invocations:
        print(f"  {inv.slug}: {' '.join(shlex.quote(p) for p in inv.cmd)}")
    return 0


def mode_create_only(run_id: str, board: Optional[str], graph_name: str) -> int:
    if board and not _ensure_board_exists(board):
        return 1
    graph = load_graph(graph_name, repo_root=REPO_ROOT)
    invocations = author_colony_lane(graph, epic_bot=EPIC_BOT, board=board)
    map_card = load_map_card(REPO_ROOT / "data/runtime/last-scenario-map.json")
    preds = acceptance_predicates_from_map(map_card)
    if graph_name == "proc-scout-stress":
        preds = acceptance_predicates_from_map(
            map_card, marks=("overlook", "muster", "return_post"),
        )

    trial_dir = POSTMORTEMS_DIR / run_id
    trial_dir.mkdir(parents=True, exist_ok=True)
    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("run_started", run_id=run_id, graph=graph_name, board=board)

    slug_to_id: dict[str, str] = {}
    manifest_cards: list[dict] = []
    for inv in invocations:
        cmd = resolve_parents(inv, slug_to_id)
        card_id = _run_hermes_create(cmd)
        if card_id is None:
            break
        slug_to_id[inv.slug] = card_id
        manifest_cards.append({
            "slug": inv.slug,
            "card_id": card_id,
            "assignee": _assignee_from_cmd(inv.cmd),
            "bot": EPIC_BOT,
            "title": inv.title,
            "depends_on_slugs": list(inv.depends_on_slugs),
            "created_at": int(time.time()),
        })
        telemetry.emit("card_created", slug=inv.slug, card_id=card_id)

    manifest = {
        "run_id": run_id,
        "tenant": DEFAULT_TENANT,
        "board": board,
        "bot": EPIC_BOT,
        "graph": graph_name,
        "tier": tier_from_graph(graph_name),
        "map_seed": _map_seed_from_env(run_id),
        "cards": manifest_cards,
        "cards_total": len(invocations),
        "acceptance_predicates": preds,
        "manual_interventions": [],
    }
    (trial_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return 0 if len(manifest_cards) == len(invocations) else 1


def mode_watch(
    run_id: str,
    watch_timeout_s: int,
    poll_interval_s: int,
    *,
    mox_url: str,
    position_poll_s: int = 30,
) -> int:
    trial_dir = POSTMORTEMS_DIR / run_id
    manifest_path = trial_dir / "manifest.json"
    if not manifest_path.exists():
        print("[proc-nav] missing manifest; run --create-only first", file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text())
    card_ids = [c["card_id"] for c in manifest["cards"]]
    slug_by_id = {c["card_id"]: c["slug"] for c in manifest["cards"]}
    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("watch_started", run_id=run_id)
    last_status: dict[str, str] = {}
    started_at = int(time.time())
    last_pos_poll = 0
    while True:
        now = int(time.time())
        if now - last_pos_poll >= position_poll_s:
            pos = _poll_mox_position(mox_url)
            if pos:
                telemetry.emit("position_snapshot", position=pos)
            last_pos_poll = now

        statuses = query_board_statuses(card_ids)
        for cid, status in statuses.items():
            prev = last_status.get(cid)
            if prev != status:
                slug = slug_by_id.get(cid, cid)
                telemetry.emit(
                    "card_terminal" if status in ("done", "blocked", "archived")
                    else "card_transition",
                    slug=slug,
                    card_id=cid,
                    from_status=prev,
                    to_status=status,
                )
                last_status[cid] = status

        terminal = {"done", "blocked", "archived"}
        if statuses and all(s in terminal for s in statuses.values()):
            telemetry.emit("watch_finished", reason="all_terminal")
            return 0
        if now - started_at > watch_timeout_s:
            telemetry.emit("watch_finished", reason="timeout")
            return 1
        time.sleep(poll_interval_s)


def collect_feedback(run_id: str, trial_dir: Path) -> int:
    """Collect `mc feedback` lines into the postmortem dir.

    Workers append tooling-friction notes to data/runtime/feedback-<bot>.jsonl.
    Lines tagged with this run_id — or with run_id null, since RUN_ID often
    doesn't survive env passthrough to bot servers — move to
    <trial_dir>/feedback.jsonl; unrelated lines stay in the runtime files.
    """
    runtime_dir = REPO_ROOT / "data" / "runtime"
    collected: list[str] = []
    for src in sorted(runtime_dir.glob("feedback-*.jsonl")):
        keep: list[str] = []
        for line in src.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                keep.append(line)
                continue
            if entry.get("run_id") in (run_id, None):
                collected.append(line)
            else:
                keep.append(line)
        if keep:
            src.write_text("\n".join(keep) + "\n")
        else:
            src.unlink()
    if collected:
        (trial_dir / "feedback.jsonl").write_text("\n".join(collected) + "\n")
    return len(collected)


def mode_evaluate_only(run_id: str, *, use_tester: bool, mox_url: str = DEFAULT_MOX_URL) -> int:
    trial_dir = POSTMORTEMS_DIR / run_id
    manifest_path = trial_dir / "manifest.json"
    if not manifest_path.exists():
        return 1
    manifest = json.loads(manifest_path.read_text())
    cards = manifest["cards"]
    card_ids = [c["card_id"] for c in cards]
    cards_total = manifest.get("cards_total", len(card_ids))
    graph_name = manifest.get("graph", "proc-scout")
    tier = manifest.get("tier") or tier_from_graph(graph_name)

    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("evaluate_started", run_id=run_id)

    feedback_count = collect_feedback(run_id, trial_dir)
    if feedback_count:
        telemetry.emit("feedback_collected", count=feedback_count)

    statuses = query_board_statuses(card_ids)
    cards_done = sum(1 for c in cards if statuses.get(c["card_id"]) == "done")

    kanban_db = _kanban_db()
    verb_counts: dict[str, int] = {}
    for c in cards:
        corpus = _session_corpus_for_card(kanban_db, c["card_id"])
        verb_counts = merge_verb_counts(verb_counts, count_mc_verbs_from_text(corpus))

    predicates = resolve_for_evaluate(manifest, trial_dir)
    per_predicate: list[dict] = []
    all_satisfied = False
    all_evaluable = False
    if use_tester and predicates:
        tester_url = os.environ.get("MC_TESTER_URL", DEFAULT_TESTER_URL)
        try:
            acc = evaluate_all(predicates, tester_url=tester_url)
            all_satisfied = acc.satisfied
            all_evaluable = acc.evaluable
            for pred, result in zip(predicates, acc.per_predicate):
                per_predicate.append({
                    "predicate": pred,
                    "satisfied": result.satisfied,
                    "evaluable": result.evaluable,
                    "detail": result.detail,
                })
        except Exception as exc:  # noqa: BLE001
            per_predicate.append({"error": str(exc)})

    first_ts = min(c.get("created_at") or 0 for c in cards) if cards else 0
    wall_time_s = int(time.time()) - first_ts if first_ts else 0

    thresholds = load_thresholds(REPO_ROOT)
    mc_total = sum(verb_counts.values())
    scorecard = {
        "run_id": run_id,
        "tier": tier,
        "graph": graph_name,
        "band": "pass" if cards_done == cards_total else "partial",
        "cards_done_count": cards_done,
        "cards_total": cards_total,
        "wall_time_s": wall_time_s,
        "manual_interventions": manifest.get("manual_interventions", []),
        "mc_cli_invocations": mc_total,
        "mc_scene_count": verb_counts.get("scene", 0),
        "mc_go_mark_count": verb_counts.get("go_mark", 0),
        "nav_escape_count": verb_counts.get("escape", 0),
        "mc_build_stairs_count": verb_counts.get("build_stairs", 0),
        "mc_dig_count": verb_counts.get("dig", 0),
        "anchors_reached_ratio": 1.0 if cards_done == cards_total else cards_done / max(1, cards_total),
        "acceptance_satisfied": all_satisfied,
        "acceptance_evaluable": all_evaluable,
        "per_predicate": per_predicate,
        "thresholds_ref": str(REPO_ROOT / "calibration/proc-nav-thresholds.yaml"),
        "thresholds": thresholds,
        "card_statuses": {c["slug"]: statuses.get(c["card_id"], "?") for c in cards},
    }
    (trial_dir / "scorecard.json").write_text(json.dumps(scorecard, indent=2))
    telemetry.emit("scorecard", **{k: scorecard[k] for k in scorecard if k != "per_predicate"})

    map_card = load_map_card(REPO_ROOT / "data/runtime/last-scenario-map.json")
    # Fetch live marks from Mox so the spatial map can show what the bot
    # actually has cached (vs the static anchors from the map JSON). Best-
    # effort: missing Mox or HTTP failure → render with empty marks list.
    live_marks: list[dict] = []
    try:
        import urllib.request as _urlreq
        with _urlreq.urlopen(f"{mox_url}/marks", timeout=3) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        for m in (body.get("data", {}).get("marks") or body.get("marks") or []):
            if isinstance(m.get("x"), (int, float)) and isinstance(m.get("z"), (int, float)):
                live_marks.append({
                    "name": m.get("name", ""),
                    "x": float(m["x"]),
                    "z": float(m["z"]),
                    "y": float(m.get("y", 0)),
                })
    except Exception as exc:  # noqa: BLE001 — best-effort decoration
        print(f"[proc-nav] WARN: could not fetch live marks from {mox_url}: {exc}", file=sys.stderr)
    spatial = render_spatial_map_html(
        trial_dir=trial_dir, map_card=map_card, marks=live_marks,
    )
    scorecard["spatial_map_path"] = str(spatial.relative_to(REPO_ROOT))
    (trial_dir / "scorecard.json").write_text(json.dumps(scorecard, indent=2))

    if tier in ("stress", "road") and not spatial.is_file():
        print(f"[proc-nav] {tier} tier missing spatial-map.html", file=sys.stderr)
        return 1

    print(
        f"[proc-nav] scorecard tier={tier} cards={cards_done}/{cards_total} "
        f"mc_verbs={mc_total} tester_ok={all_satisfied}"
    )
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--create-only", action="store_true")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--evaluate-only", action="store_true")
    parser.add_argument("--watch-timeout", type=int, default=7200)
    parser.add_argument("--poll-interval", type=int, default=10)
    parser.add_argument("--board", default=DEFAULT_BOARD)
    parser.add_argument("--graph", default="proc-scout", choices=sorted(PROC_NAV_GRAPHS))
    parser.add_argument(
        "--evaluate-tester",
        action="store_true",
        help="optional: run Tester mc verify predicates",
    )
    parser.add_argument("--mox-url", default=os.environ.get("MC_API_URL", DEFAULT_MOX_URL))
    args = parser.parse_args(argv)

    global _BOARD
    _BOARD = args.board or None

    if args.dry_run:
        return mode_dry_run(_BOARD, args.graph)
    if not args.run_id:
        parser.error("--run-id required for live modes")
    if args.create_only:
        return mode_create_only(args.run_id, _BOARD, args.graph)
    if args.watch:
        return mode_watch(
            args.run_id,
            args.watch_timeout,
            args.poll_interval,
            mox_url=args.mox_url,
        )
    if args.evaluate_only:
        return mode_evaluate_only(args.run_id, use_tester=args.evaluate_tester, mox_url=args.mox_url)
    parser.error("pick a mode")
    return 64


if __name__ == "__main__":
    sys.exit(main())
