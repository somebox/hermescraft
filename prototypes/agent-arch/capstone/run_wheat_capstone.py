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
W1_EXECUTE_ROLES = ("navigator", "builder", "farmer", "crafter")


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

def _assignee_from_cmd(cmd: tuple[str, ...]) -> str:
    return cmd[cmd.index("--assignee") + 1]


def _skills_from_cmd(cmd: tuple[str, ...]) -> list[str]:
    skills: list[str] = []
    i = 0
    while i < len(cmd):
        if cmd[i] == "--skill":
            skills.append(cmd[i + 1])
        i += 1
    return skills


def _validate_w1_dry_run(graph, invocations) -> int:
    """Architecture gate for W1 authoring shape."""
    errors: list[str] = []
    if len(invocations) != len(graph.cards):
        errors.append(f"expected {len(graph.cards)} invocations, got {len(invocations)}")
    slug_to_card = {c.slug: c for c in graph.cards}
    for inv in invocations:
        card = slug_to_card.get(inv.slug)
        if not card:
            errors.append(f"unknown slug {inv.slug}")
            continue
        assignee = _assignee_from_cmd(inv.cmd)
        if assignee != card.assignee:
            errors.append(f"{inv.slug}: assignee {assignee!r} != graph {card.assignee!r}")
        if assignee not in W1_EXECUTE_ROLES:
            errors.append(f"{inv.slug}: assignee {assignee!r} not a role slug")
        title = inv.cmd[-1]
        if "[bot:mox]" not in title.lower():
            errors.append(f"{inv.slug}: title missing [bot:mox]: {title!r}")
        expected_skills = list(card.skills)
        got_skills = _skills_from_cmd(inv.cmd)
        if got_skills != expected_skills:
            errors.append(
                f"{inv.slug}: skills mismatch expected={expected_skills} got={got_skills}"
            )
    if errors:
        for e in errors:
            print(f"[runner] dry-run FAIL: {e}", file=sys.stderr)
        return 1
    print("[runner] dry-run: W1 shape checks passed")
    return 0


def mode_dry_run(board: Optional[str] = None) -> int:
    graph = build_default_graph()
    invocations = author_colony_lane(graph, epic_bot=EPIC_BOT, board=board)
    print(f"[runner] dry-run: {len(invocations)} invocations  "
          f"(board={board or '(proto/default)'})")
    for inv in invocations:
        print(f"  {inv.slug}: {' '.join(shlex.quote(p) for p in inv.cmd)}")
        if inv.depends_on_slugs:
            print(f"    depends_on: {', '.join(inv.depends_on_slugs)}")
    print()
    print(f"[runner] acceptance: {len(graph.acceptance_predicates or [])} predicates")
    for p in (graph.acceptance_predicates or []):
        print(f"  {p['kind']}: {json.dumps({k: v for k, v in p.items() if k != 'kind'})}")
    return _validate_w1_dry_run(graph, invocations)


def mode_create_only(run_id: str, board: Optional[str] = None) -> int:
    if board:
        if not _ensure_board_exists(board):
            return 1
    graph = build_default_graph()
    invocations = author_colony_lane(graph, epic_bot=EPIC_BOT, board=board)

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
        manifest_cards.append({
            "slug": inv.slug,
            "card_id": card_id,
            "assignee": _assignee_from_cmd(inv.cmd),
            "bot": EPIC_BOT,
            "title": inv.title,
            "depends_on_slugs": list(inv.depends_on_slugs),
            "created_at": int(time.time()),
        })
        telemetry.emit("card_created", slug=inv.slug, card_id=card_id,
                       assignee=_assignee_from_cmd(inv.cmd), bot=EPIC_BOT)
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


def _hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))


def _kanban_db_for_manifest(manifest: dict) -> Path:
    board = manifest.get("board")
    home = _hermes_home()
    if board:
        path = home / "kanban" / "boards" / board / "kanban.db"
        if path.exists():
            return path
    legacy = home / "kanban.db"
    if legacy.exists():
        return legacy
    return path if board else legacy


def _completed_run_metadata(kanban_db: Path, task_id: str) -> dict:
    if not kanban_db.exists():
        return {}
    conn = sqlite3.connect(kanban_db)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT metadata, outcome
            FROM task_runs
            WHERE task_id = ? AND outcome = 'completed'
            ORDER BY started_at DESC
            LIMIT 1
            """,
            (task_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not row["metadata"]:
        return {}
    return json.loads(row["metadata"])


def _task_assignee(kanban_db: Path, task_id: str) -> Optional[str]:
    if not kanban_db.exists():
        return None
    conn = sqlite3.connect(kanban_db)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            "SELECT assignee FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
    finally:
        conn.close()
    return row["assignee"] if row else None


def _role_env_has_mc_vars() -> bool:
    """W1 routes MC_* through profile .env (Hermes strips them at spawn —
    see kanban_db.py:6671). The architectural gate is now: every role
    .env carries MC_API_URL + MC_USERNAME so the worker can reach Mox."""
    home = _hermes_home()
    for role in W1_EXECUTE_ROLES:
        env_path = home / "profiles" / role / ".env"
        if not env_path.is_file():
            return False
        text = env_path.read_text()
        for key in ("MC_API_URL", "MC_USERNAME"):
            if f"{key}=" not in text:
                return False
    return True


def _handoff_band_x001_x002(manifest: dict, kanban_db: Path) -> str:
    """pass | partial | fail for nav→builder handoff edge."""
    slug_to_id = {c["slug"]: c["card_id"] for c in manifest.get("cards", [])}
    if "x001" not in slug_to_id or "x002" not in slug_to_id:
        return "fail"
    parent_md = _completed_run_metadata(kanban_db, slug_to_id["x001"])
    has_exit = bool(parent_md.get("exit_pos"))
    has_mark = bool(parent_md.get("work_at_mark"))
    if not has_exit and not has_mark:
        return "fail"
    child_md = _completed_run_metadata(kanban_db, slug_to_id["x002"])
    child_sid = child_md.get("worker_session_id")
    if not child_sid:
        return "partial"
    child_assignee = next(
        (c["assignee"] for c in manifest.get("cards", []) if c["slug"] == "x002"),
        "builder",
    )
    child_role = child_assignee
    db = _hermes_home() / "profiles" / child_role / "state.db"
    if not db.exists():
        return "partial"
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT content, tool_calls, reasoning
            FROM messages WHERE session_id = ?
            ORDER BY id
            """,
            (child_sid,),
        ).fetchall()
    finally:
        conn.close()
    corpus = "\n".join(
        str(r[c] or "") for r in rows for c in ("content", "tool_calls", "reasoning")
    )
    needles: list[str] = []
    if has_exit:
        ep = parent_md["exit_pos"]
        if isinstance(ep, list):
            needles.append(json.dumps(ep, separators=(", ", ": ")))
            needles.append(",".join(str(v) for v in ep))
    if has_mark:
        needles.append(str(parent_md["work_at_mark"]))
    if any(n and n in corpus for n in needles):
        return "pass"
    return "partial"


def _build_architectural_scorecard(manifest: dict, kanban_db: Path) -> dict:
    cards = manifest.get("cards", [])
    profiles_per_slug = {c["slug"]: c["assignee"] for c in cards}
    session_ids: list[str] = []
    assignee_mismatches: list[str] = []
    for c in cards:
        md = _completed_run_metadata(kanban_db, c["card_id"])
        sid = md.get("worker_session_id")
        if sid:
            session_ids.append(sid)
        db_assignee = _task_assignee(kanban_db, c["card_id"])
        if db_assignee and db_assignee != c["assignee"]:
            assignee_mismatches.append(
                f"{c['slug']}: task={db_assignee} manifest={c['assignee']}"
            )
    home = _hermes_home()
    return {
        "injection_mode": "single_bot_fixed_mox_via_dotenv",
        "injection_ceiling_note": (
            "MC_* routed via role .env because Hermes spawn strips them "
            "(kanban_db.py:6671); not per-card bot lookup (W4)."
        ),
        "profiles_per_slug": profiles_per_slug,
        "distinct_worker_session_ids": len(set(session_ids)),
        "worker_session_ids": session_ids,
        "role_env_has_mc_vars": _role_env_has_mc_vars(),
        "pilot_mox_absent": not (home / "profiles" / "pilot-mox").is_dir(),
        "handoff_x001_x002": _handoff_band_x001_x002(manifest, kanban_db),
        "assignee_mismatches": assignee_mismatches,
    }


def _run_verify_observer_prep() -> int:
    """Teleport Tester near the wheat plot so acceptance predicates load chunks."""
    script = REPO_ROOT / "scripts" / "prep-wheat-verify-observer.sh"
    if not script.is_file():
        print(f"[runner] WARN: missing {script}; skipping verify prep", file=sys.stderr)
        return 0
    print(f"[runner] running {script.name} before acceptance evaluate")
    proc = subprocess.run([str(script)], cwd=str(REPO_ROOT), env=os.environ.copy())
    if proc.returncode != 0:
        print(f"[runner] verify prep failed (exit {proc.returncode})", file=sys.stderr)
        return proc.returncode
    return 0


def mode_evaluate_only(run_id: str) -> int:
    trial_dir = POSTMORTEMS_DIR / run_id
    manifest_path = trial_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"[runner] no manifest at {manifest_path}", file=sys.stderr)
        return 1
    prep_rc = _run_verify_observer_prep()
    if prep_rc != 0:
        return prep_rc
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

    kanban_db = _kanban_db_for_manifest(manifest)
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
        "architectural": _build_architectural_scorecard(manifest, kanban_db),
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
    args = parser.parse_args(argv)

    global _BOARD
    _BOARD = args.board or None

    if args.dry_run:
        return mode_dry_run(board=_BOARD)

    if not args.run_id:
        parser.error("--run-id required for non-dry-run modes")
    run_id = args.run_id

    if args.create_only:
        return mode_create_only(run_id, board=_BOARD)
    if args.watch:
        manifest = POSTMORTEMS_DIR / run_id / "manifest.json"
        if not manifest.exists():
            rc = mode_create_only(run_id, board=_BOARD)
            if rc != 0:
                return rc
        return mode_watch(run_id, args.watch_timeout, args.poll_interval)
    if args.evaluate_only:
        return mode_evaluate_only(run_id)

    parser.error("pick one mode: --dry-run | --create-only | --watch | --evaluate-only")
    return 64


if __name__ == "__main__":
    sys.exit(main())
