#!/usr/bin/env python3
"""Phase 10 PR-S — AUTO_STUCK runtime event.

When a worker's `recent[]` action tuple AND position are identical for N
consecutive rounds, emit a structured `kanban_comment` on the active card.
Steward's diagnostics cycle reads comments — chat whispers don't enter the
worker's decision loop, but comments are the durable control plane.

Run-6 evidence: Flint stuck at (14.5, 102, 7.6) for ~70 min; `recent[]`
identical (`["inspect:done","move:done","pillar_step:done","move:error"]`)
across 42 consecutive rounds. Steward issued 3+ chat rescues; Flint
never acted on any. PR-S surfaces the same signal via the channel
Steward's loop actually reads.

Pure-function core (`detect_auto_stuck`) is unit-testable without the
runtime; the CLI wrapper handles state-file lookup + comment emission.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


# How many consecutive identical rounds before we fire. 4 is enough to
# distinguish a genuine stuck loop from a single-round retry without
# being so high that 5 wasted rounds (~5 min) elapse before Steward sees
# the signal.
DEFAULT_ROUNDS = 4

# Tolerance for "same position" — bots jitter by fractions on idle.
# `pos` is already int-floored in the progress emitter; threshold 0 means
# strictly identical cells, 1 allows one-block drift.
DEFAULT_POS_TOLERANCE = 0

# Run-7 Step 2 (PR-S) — escalation cadence. The watchdog ticks every 8s
# and detect_auto_stuck requires 4 identical entries (~32s window). Once
# we comment, we wait at least DEBOUNCE before escalating so the prior
# action has time to take effect (a reclaim spawns a fresh worker which
# needs >~10s to come up + start a new card pose). 45s default.
DEFAULT_DEBOUNCE_SECONDS = 45

# Comment-body prefixes that encode escalation stage. Recovering state
# from these comments alone (no schema change to task_events) keeps the
# escalation policy idempotent across watchdog restarts.
_PFX_COMMENT = "[AUTO_STUCK]"
_PFX_RECLAIM = "[AUTO_STUCK_RECLAIM]"
_PFX_BLOCK = "[AUTO_STUCK_BLOCK]"

# Stage strings used by decide_action / tests.
STAGE_COMMENT = "comment"
STAGE_RECLAIM = "reclaim"
STAGE_BLOCK = "block"
STAGE_NOOP = "noop"


@dataclass(frozen=True)
class StuckSignal:
    """Returned by `detect_auto_stuck` when the condition fires."""
    rounds: int
    position: dict
    recent_tuple: list[str]
    first_round: int  # round number where the streak began
    last_round: int   # round number of current entry


def _pos_equal(a: Optional[dict], b: Optional[dict], tolerance: int = 0) -> bool:
    if a is None or b is None:
        return False
    for k in ("x", "y", "z"):
        ax, bx = a.get(k), b.get(k)
        if ax is None or bx is None:
            return False
        if abs(int(ax) - int(bx)) > tolerance:
            return False
    return True


def detect_auto_stuck(
    entries: Iterable[dict],
    threshold: int = DEFAULT_ROUNDS,
    pos_tolerance: int = DEFAULT_POS_TOLERANCE,
) -> Optional[StuckSignal]:
    """Look at the last N progress entries (oldest first). Returns a
    `StuckSignal` if all `threshold` most-recent entries have identical
    `recent[]` AND identical `pos` (within tolerance).

    Parameters
    ----------
    entries : iterable of dict
        Progress log entries with at least `round`, `recent`, `pos` fields.
        We only look at the last `threshold` entries.
    threshold : int
        Number of consecutive entries that must match.
    pos_tolerance : int
        Max |delta| per axis to count as "same position".
    """
    items = list(entries)
    if len(items) < threshold:
        return None
    window = items[-threshold:]

    # All recent tuples must match the last one.
    last_recent = window[-1].get("recent")
    if not isinstance(last_recent, list) or not last_recent:
        return None
    for e in window:
        if e.get("recent") != last_recent:
            return None

    # All positions must match within tolerance.
    last_pos = window[-1].get("pos")
    if not last_pos:
        return None
    for e in window:
        if not _pos_equal(e.get("pos"), last_pos, pos_tolerance):
            return None

    first_round = window[0].get("round", 0)
    last_round = window[-1].get("round", 0)
    return StuckSignal(
        rounds=threshold,
        position=dict(last_pos),
        recent_tuple=list(last_recent),
        first_round=first_round,
        last_round=last_round,
    )


def read_progress_tail(path: Path, n: int) -> list[dict]:
    """Read the last `n` non-blank JSON-lines from a progress log."""
    if not path.is_file():
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    out: list[dict] = []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
        if len(out) >= n:
            break
    out.reverse()
    return out


def stuck_fingerprint(signal: StuckSignal) -> str:
    """Compact, stable fingerprint of a stuck episode. Same position +
    same recent[] tuple → same fp across watchdog ticks, so the
    escalation history is keyed correctly even when the bot has multiple
    successive stuck episodes (rare but possible: stuck → reclaim →
    different stuck → fresh comment cycle)."""
    blob = json.dumps(
        {"pos": signal.position, "recent": signal.recent_tuple},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]


def latest_action_for_fingerprint(
    db_path: Path, task_id: str, fingerprint: str
) -> tuple[Optional[str], Optional[float]]:
    """Read task_comments for the most recent AUTO_STUCK-tagged entry
    matching this fingerprint. Returns (stage, age_seconds) where
    stage is one of STAGE_COMMENT / STAGE_RECLAIM / STAGE_BLOCK / None.

    The stage prefix determines what action was last taken; the
    `age_seconds` is used to debounce repeated escalations within one
    detection window.
    """
    if not db_path.is_file():
        return None, None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        row = conn.execute(
            "SELECT body, created_at FROM task_comments "
            "WHERE task_id = ? AND body LIKE ? "
            "ORDER BY created_at DESC LIMIT 1",
            (task_id, f"%fp={fingerprint}%"),
        ).fetchone()
        conn.close()
    except sqlite3.Error:
        return None, None
    if row is None:
        return None, None
    body, created_at = row
    if not isinstance(body, str):
        return None, None
    if body.startswith(_PFX_BLOCK):
        stage = STAGE_BLOCK
    elif body.startswith(_PFX_RECLAIM):
        stage = STAGE_RECLAIM
    elif body.startswith(_PFX_COMMENT):
        stage = STAGE_COMMENT
    else:
        return None, None
    age = time.time() - created_at if created_at else None
    return stage, age


def decide_action(
    prior_stage: Optional[str], age_seconds: Optional[float], debounce: float
) -> str:
    """Step-change escalation policy. The watchdog calls this every tick
    that detect_auto_stuck() fires; this function decides what to do.

    States: None → comment → reclaim → block → noop (terminal).
    Debounce prevents back-to-back escalations within one detection
    window (the prior action needs time to land).
    """
    if prior_stage == STAGE_BLOCK:
        return STAGE_NOOP
    if prior_stage is None:
        return STAGE_COMMENT
    if age_seconds is not None and age_seconds < debounce:
        return STAGE_NOOP
    if prior_stage == STAGE_COMMENT:
        return STAGE_RECLAIM
    if prior_stage == STAGE_RECLAIM:
        return STAGE_BLOCK
    return STAGE_NOOP


def format_comment_body(signal: StuckSignal, fingerprint: str) -> str:
    pos = signal.position
    return (
        f"{_PFX_COMMENT} fp={fingerprint}: identical recent[] for "
        f"{signal.rounds} rounds at ({pos.get('x')},{pos.get('y')},{pos.get('z')}). "
        f"recent_tuple={json.dumps(signal.recent_tuple)} "
        f"first_round={signal.first_round} last_round={signal.last_round}. "
        f"Steward: kanban_comment a diagnosis + reclaim/reassign. mc chat "
        f"whispers don't enter the worker's decision loop — comments do. "
        f"If this fp recurs after reclaim, the watchdog will auto-block. "
        f"Worker: before retrying, run mc read_chat 20 and mc reachable on "
        f"the card target; if target is not standable use best_stand via "
        f"mc goto_near range=1. Do not repeat the same recent[] verb."
    )


def format_reclaim_explainer(signal: StuckSignal, fingerprint: str) -> str:
    return (
        f"{_PFX_RECLAIM} fp={fingerprint}: prior {_PFX_COMMENT} did not "
        f"unstick the worker (same recent[] for {signal.rounds}+ rounds). "
        f"Auto-reclaim now; if the new worker hits the same fp, the next "
        f"escalation is block. Steward: while the new worker spawns, "
        f"consider editing the card body — same fp after reclaim usually "
        f"means the card spec is the problem, not the runtime."
    )


def format_block_reason(signal: StuckSignal, fingerprint: str) -> str:
    return (
        f"{_PFX_BLOCK} fp={fingerprint}: identical recent[] persisted "
        f"across an auto-reclaim — card spec is broken or the env "
        f"reproducibly traps the worker. Steward: edit the body, "
        f"reassign, or file a [RESCUE]. Pose: ({signal.position.get('x')},"
        f"{signal.position.get('y')},{signal.position.get('z')})."
    )


def _hermes_kanban(args: list[str], timeout: int = 15) -> bool:
    """Shell out to `hermes kanban …`. Returns True on success."""
    cmd = ["hermes", "kanban"] + args
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    return proc.returncode == 0


def emit_comment(task_id: str, body: str, board: Optional[str] = None) -> bool:
    head: list[str] = []
    if board:
        head = ["--board", board]
    return _hermes_kanban(head + ["comment", task_id, body])


def emit_reclaim(task_id: str, signal: StuckSignal, fingerprint: str,
                 board: Optional[str] = None) -> bool:
    """Step-change escalation: comment an explainer, then trigger
    `hermes kanban reclaim`. The explainer lands in task_comments so the
    fingerprint history is recoverable across watchdog restarts."""
    if not emit_comment(task_id, format_reclaim_explainer(signal, fingerprint), board=board):
        # Don't reclaim if we couldn't tag the history — the next tick
        # would think we're still at stage=comment and re-escalate.
        return False
    head: list[str] = []
    if board:
        head = ["--board", board]
    return _hermes_kanban(head + ["reclaim", task_id])


def emit_block(task_id: str, signal: StuckSignal, fingerprint: str,
               board: Optional[str] = None) -> bool:
    reason = format_block_reason(signal, fingerprint)
    head: list[str] = []
    if board:
        head = ["--board", board]
    return _hermes_kanban(head + ["block", task_id, reason])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--progress-log", type=Path, required=True,
                    help="Path to the per-bot progress.log file")
    ap.add_argument("--task-id", required=True,
                    help="Active kanban task id to comment on")
    ap.add_argument("--kanban-db", type=Path,
                    help="Path to kanban.db for idempotency lookup")
    ap.add_argument("--board", default=None,
                    help="Kanban board name passed to `hermes kanban`")
    ap.add_argument("--rounds", type=int, default=DEFAULT_ROUNDS)
    ap.add_argument("--pos-tolerance", type=int, default=DEFAULT_POS_TOLERANCE)
    ap.add_argument("--debounce-seconds", type=float, default=DEFAULT_DEBOUNCE_SECONDS,
                    help="Minimum seconds between escalation stages for a given fingerprint")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the next action + body to stdout instead of shelling out")
    args = ap.parse_args()

    entries = read_progress_tail(args.progress_log, args.rounds)
    signal = detect_auto_stuck(entries, args.rounds, args.pos_tolerance)
    if signal is None:
        return 0

    fp = stuck_fingerprint(signal)
    prior_stage, age = (None, None)
    if args.kanban_db:
        prior_stage, age = latest_action_for_fingerprint(args.kanban_db, args.task_id, fp)
    action = decide_action(prior_stage, age, args.debounce_seconds)

    if action == STAGE_NOOP:
        return 0

    if action == STAGE_COMMENT:
        body = format_comment_body(signal, fp)
    elif action == STAGE_RECLAIM:
        body = format_reclaim_explainer(signal, fp)
    elif action == STAGE_BLOCK:
        body = format_block_reason(signal, fp)
    else:  # defensive
        return 0

    if args.dry_run:
        print(f"action={action} fp={fp}")
        print(body)
        return 0

    if action == STAGE_COMMENT:
        ok = emit_comment(args.task_id, body, board=args.board)
    elif action == STAGE_RECLAIM:
        ok = emit_reclaim(args.task_id, signal, fp, board=args.board)
    else:  # STAGE_BLOCK
        ok = emit_block(args.task_id, signal, fp, board=args.board)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
