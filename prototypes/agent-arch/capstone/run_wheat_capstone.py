#!/usr/bin/env python3
"""Runner for the wheat-farm capstone (Session 5b).

Mirrors ``run_two_bot_base.py``'s mode set (``--dry-run``,
``--create-only``, ``--watch``, ``--evaluate-only``) and ``--board``
flag, but consumes:

  - ``capstone.wheat_graph.build_default_graph()`` — 4-card single-bot
    chain on mox (nav → build → farm → deposit).
  - ``capstone.acceptance.evaluate_all()`` over the graph's
    ``acceptance_predicates`` (3 predicates: 9×9 farmland region,
    9×9 wheat region, water source at field center).

The fixture this expects to be in effect is
``data/test-fixtures/colony/wheat_capstone.yaml`` — a clean 11×11
dirt-floored arena at (-50, 64, 50) with Mox tp'd to the west edge
holding a wooden_hoe + 64 wheat_seeds.

Scorecard fields (written to ``scorecard.json`` after evaluate):

  band                : pass | partial | fail
  cards_done_count    : 0..4
  cards_total         : 4
  wall_time_s         : seconds from create to last terminal
  acceptance_band     : all-of result over acceptance_predicates
  per_predicate       : list of {kind, satisfied, evaluable, detail}
  card_statuses       : {slug: status}

Pass  = cards_done_count == cards_total AND acceptance_band == pass
Partial = cards_done_count > 0 OR any predicate satisfied
Fail   = no cards created OR no progress

Confound table for postmortem (per the colony validation plan §
"Capstone"):

  - cards all done + all predicates satisfied → A6 supported
    (per-card scope reset works on multi-domain wheat task)
  - cards all done but predicates fail → suggests bundle gaps
    (farmer didn't till/plant; acceptance gate is honest)
  - some cards blocked → A6 inconclusive; investigate which card

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md
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
from pathlib import Path
from typing import Optional

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from capstone.acceptance import evaluate_all  # noqa: E402
from capstone.author import (  # noqa: E402
    DEFAULT_MAX_RUNTIME,
    DEFAULT_TENANT,
    author_colony_lane,
    resolve_parents,
)
from capstone.wheat_graph import EPIC_BOT, build_default_graph  # noqa: E402

REPO_ROOT = _HERE.parent.parent.parent
POSTMORTEMS_DIR = REPO_ROOT / "data" / "postmortems" / "wheat-capstone"
DEFAULT_TESTER_URL = "http://127.0.0.1:3004"
DEFAULT_BOARD = "wheat-capstone"


# ── Telemetry shim — minimal JSONL emitter ─────────────────────────

class TelemetryWriter:
    """Append-only JSONL writer. Same shape as the two-bot runner so
    existing follower/analyzer tooling works across capstones."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, kind: str, **payload) -> None:
        event = {"kind": kind, "at": int(time.time()), **payload}
        with self.path.open("a") as f:
            f.write(json.dumps(event) + "\n")


# ── Subprocess helpers ─────────────────────────────────────────────

def _hermes_env() -> dict:
    env = dict(os.environ)
    env.setdefault(
        "HERMES_HOME", os.path.expanduser("~/.hermes"),
    )
    return env


def _ensure_board_exists(board: str) -> bool:
    """Idempotent `hermes kanban boards create <slug>`."""
    proc = subprocess.run(
        ["hermes", "kanban", "boards", "create", board],
        env=_hermes_env(), capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"[runner] could not ensure board {board!r}: {proc.stderr.strip()}",
              file=sys.stderr)
        return False
    return True


def _run_hermes_create(cmd: tuple[str, ...]) -> Optional[str]:
    proc = subprocess.run(cmd, env=_hermes_env(), capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"[runner] hermes create failed (exit {proc.returncode}):"
              f"\n  cmd: {' '.join(shlex.quote(p) for p in cmd)}"
              f"\n  stderr: {proc.stderr.strip()}", file=sys.stderr)
        return None
    try:
        payload = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        print(f"[runner] hermes create returned non-JSON: {proc.stdout!r}",
              file=sys.stderr)
        return None
    return payload.get("id") or payload.get("task_id") or payload.get("uuid")


# ── Board introspection ────────────────────────────────────────────

_BOARD: Optional[str] = None


def _hermes_home() -> Path:
    return Path(_hermes_env()["HERMES_HOME"])


def _kanban_db() -> Path:
    """Pick the right DB file for the active board layout."""
    home = _hermes_home()
    if _BOARD:
        path = home / "kanban" / "boards" / _BOARD / "kanban.db"
        if path.exists():
            return path
    return home / "kanban.db"


def query_board_statuses(card_ids: list[str]) -> dict[str, str]:
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


# ── Mode implementations ───────────────────────────────────────────

def _override_assignees(invocations, override: Optional[str]):
    """If ``override`` is set, replace every invocation's ``--assignee``
    value with it. Used to route all 4 role-named cards (navigator,
    builder, farmer, crafter) to a single mox-bound profile at trial
    time; the role distinction stays in the body @-mention and the
    per-card --skill flags. Returns a new tuple (Invocation is frozen)."""
    if not override:
        return invocations
    from dataclasses import replace
    new_invs = []
    for inv in invocations:
        cmd = list(inv.cmd)
        try:
            idx = cmd.index("--assignee")
            cmd[idx + 1] = override
        except ValueError:
            pass
        new_invs.append(replace(inv, cmd=tuple(cmd)))
    return tuple(new_invs)


def mode_dry_run(board: Optional[str] = None,
                 assignee_override: Optional[str] = None) -> int:
    graph = build_default_graph()
    # Wheat graph cards leave bot=None and fall back to graph epic_bot
    # = "mox" (set in wheat_graph.EPIC_BOT). The author handles the
    # [bot:mox] title prefix.
    invocations = author_colony_lane(graph, epic_bot=EPIC_BOT, board=board)
    invocations = _override_assignees(invocations, assignee_override)
    print(f"[runner] dry-run: {len(invocations)} invocations  "
          f"(board={board or '(proto/default)'}"
          f"{', assignee=' + assignee_override if assignee_override else ''})")
    for inv in invocations:
        print(f"  {inv.slug}: {' '.join(shlex.quote(p) for p in inv.cmd)}")
        if inv.depends_on_slugs:
            print(f"    depends_on: {', '.join(inv.depends_on_slugs)}")
    print()
    print(f"[runner] acceptance: {len(graph.acceptance_predicates or [])} predicates")
    for p in (graph.acceptance_predicates or []):
        print(f"  {p['kind']}: {json.dumps({k: v for k, v in p.items() if k != 'kind'})}")
    return 0


def mode_create_only(run_id: str, board: Optional[str] = None,
                     assignee_override: Optional[str] = None) -> int:
    if board:
        if not _ensure_board_exists(board):
            return 1
    graph = build_default_graph()
    invocations = author_colony_lane(graph, epic_bot=EPIC_BOT, board=board)
    invocations = _override_assignees(invocations, assignee_override)

    trial_dir = POSTMORTEMS_DIR / run_id
    trial_dir.mkdir(parents=True, exist_ok=True)
    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("run_started", run_id=run_id, mode="create-only",
                   tenant=DEFAULT_TENANT, board=board)

    slug_to_id: dict[str, str] = {}
    manifest_cards: list[dict] = []
    for inv in invocations:
        cmd = resolve_parents(inv, slug_to_id)
        card_id = _run_hermes_create(cmd)
        if card_id is None:
            telemetry.emit("create_failed", slug=inv.slug)
            print(f"[runner] failed at {inv.slug}; manifest partial",
                  file=sys.stderr)
            break
        slug_to_id[inv.slug] = card_id
        assignee_idx = inv.cmd.index("--assignee") + 1
        manifest_cards.append({
            "slug": inv.slug,
            "card_id": card_id,
            "assignee": inv.cmd[assignee_idx],
            "bot": EPIC_BOT,
            "title": inv.title,
            "depends_on_slugs": list(inv.depends_on_slugs),
            "created_at": int(time.time()),
        })
        telemetry.emit("card_created", slug=inv.slug, card_id=card_id,
                       assignee=inv.cmd[assignee_idx], bot=EPIC_BOT)
        print(f"[runner] {inv.slug} → {card_id}")

    manifest = {
        "run_id": run_id,
        "tenant": DEFAULT_TENANT,
        "board": board,
        "bot": EPIC_BOT,
        "cards": manifest_cards,
        "cards_total": len(invocations),
        # Capstone-specific: full acceptance set + the singular fallback.
        "acceptance_predicate": graph.acceptance_predicate,
        "acceptance_predicates": graph.acceptance_predicates,
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

    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("watch_started", run_id=run_id,
                   watch_timeout_s=watch_timeout_s)

    last_status: dict[str, str] = {}
    started_at = int(time.time())
    while True:
        statuses = query_board_statuses(card_ids)
        for cid, status in statuses.items():
            prev = last_status.get(cid)
            if prev != status:
                slug = slug_by_id.get(cid, cid)
                telemetry.emit(
                    "card_terminal" if status in ("done", "blocked", "archived")
                    else "card_transition",
                    slug=slug, card_id=cid, bot=manifest["bot"],
                    from_status=prev, to_status=status,
                )
                print(f"  [t+{int(time.time()) - started_at}s] {slug}: "
                      f"{prev or '-'} → {status}")
                last_status[cid] = status

        terminal = {"done", "blocked", "archived"}
        if statuses and all(s in terminal for s in statuses.values()):
            telemetry.emit("watch_finished", reason="all_terminal")
            print(f"[runner] all cards terminal; watch done at "
                  f"t+{int(time.time()) - started_at}s")
            return 0

        if int(time.time()) - started_at > watch_timeout_s:
            telemetry.emit("watch_finished", reason="timeout")
            print(f"[runner] watch timed out after {watch_timeout_s}s",
                  file=sys.stderr)
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
    cards_total = manifest.get("cards_total", len(card_ids))

    telemetry = TelemetryWriter(trial_dir / "telemetry.jsonl")
    telemetry.emit("evaluate_started", run_id=run_id)

    # Cards
    statuses = query_board_statuses(card_ids)
    cards_done = sum(1 for c in cards
                     if statuses.get(c["card_id"]) == "done")
    cards_blocked = sum(1 for c in cards
                        if statuses.get(c["card_id"]) == "blocked")

    # Acceptance — multi-predicate
    predicates = manifest.get("acceptance_predicates") or []
    tester_url = os.environ.get("MC_TESTER_URL", DEFAULT_TESTER_URL)
    if not predicates:
        # Fall back to singular if the manifest predates the upgrade
        sp = manifest.get("acceptance_predicate")
        if sp:
            predicates = [sp]

    per_predicate: list[dict] = []
    all_satisfied = False
    all_evaluable = False
    if predicates:
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
        except Exception as e:  # noqa: BLE001
            per_predicate.append({"error": str(e)})

    # Wall time — last terminal event vs first create
    first_ts = min(c.get("created_at") or 0 for c in cards) if cards else 0
    last_ts = int(time.time())
    wall_time_s = last_ts - first_ts if first_ts else 0

    # Banding
    if cards_done == cards_total and all_satisfied:
        band = "pass"
    elif cards_done > 0 or any(p.get("satisfied") for p in per_predicate):
        band = "partial"
    else:
        band = "fail"

    scorecard = {
        "run_id": run_id,
        "band": band,
        "cards_done_count": cards_done,
        "cards_total": cards_total,
        "cards_blocked": cards_blocked,
        "wall_time_s": wall_time_s,
        "acceptance_satisfied": all_satisfied,
        "acceptance_evaluable": all_evaluable,
        "per_predicate": per_predicate,
        "card_statuses": {c["slug"]: statuses.get(c["card_id"], "?")
                          for c in cards},
    }
    (trial_dir / "scorecard.json").write_text(json.dumps(scorecard, indent=2))
    telemetry.emit("scorecard", **scorecard)

    print(f"[runner] scorecard: band={band}, cards={cards_done}/{cards_total} "
          f"(blocked={cards_blocked}), "
          f"acceptance={all_satisfied} (predicates {sum(1 for p in per_predicate if p.get('satisfied'))}/{len(per_predicate)})")
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
    parser.add_argument("--watch-timeout", type=int, default=7200)
    parser.add_argument("--poll-interval", type=int, default=10)
    parser.add_argument("--board", default=DEFAULT_BOARD,
                        help=f"kanban board (default: {DEFAULT_BOARD}). "
                             "Set to empty string '' for proto-rig "
                             "flat-workspace layout.")
    parser.add_argument("--assignee", default=None,
                        help="Override every card's --assignee with this "
                             "single profile slug (e.g. 'pilot-mox'). "
                             "Use when the live HERMES_HOME has one "
                             "mox-bound profile instead of four role "
                             "profiles. Role distinction is preserved "
                             "via the body @-mention and the per-card "
                             "--skill flags.")
    args = parser.parse_args(argv)

    global _BOARD
    _BOARD = args.board or None
    assignee = args.assignee

    if args.dry_run:
        return mode_dry_run(board=_BOARD, assignee_override=assignee)

    if not args.run_id:
        parser.error("--run-id required for non-dry-run modes")
    run_id = args.run_id

    if args.create_only:
        return mode_create_only(run_id, board=_BOARD,
                                 assignee_override=assignee)
    if args.watch:
        manifest = POSTMORTEMS_DIR / run_id / "manifest.json"
        if not manifest.exists():
            rc = mode_create_only(run_id, board=_BOARD,
                                  assignee_override=assignee)
            if rc != 0:
                return rc
        return mode_watch(run_id, args.watch_timeout, args.poll_interval)
    if args.evaluate_only:
        return mode_evaluate_only(run_id)

    parser.error("pick one mode: --dry-run | --create-only | --watch | --evaluate-only")
    return 64


if __name__ == "__main__":
    sys.exit(main())
