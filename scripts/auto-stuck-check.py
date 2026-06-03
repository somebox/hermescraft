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
import json
import subprocess
import sqlite3
import sys
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


def auto_stuck_already_signaled(
    db_path: Path, task_id: str, lookback_rounds: int = 6
) -> bool:
    """Idempotency check: was AUTO_STUCK already commented in the last
    few task events for this card? Skip re-emission to avoid spamming
    Steward when a stuck condition persists across rounds.
    """
    if not db_path.is_file():
        return False
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = conn.execute(
            "SELECT body FROM task_comments WHERE task_id = ? "
            "ORDER BY created_at DESC LIMIT ?",
            (task_id, lookback_rounds),
        ).fetchall()
        conn.close()
    except sqlite3.Error:
        return False
    return any(r[0] and "AUTO_STUCK" in r[0] for r in rows)


def format_comment_body(signal: StuckSignal) -> str:
    pos = signal.position
    return (
        f"AUTO_STUCK: identical recent[] for {signal.rounds} rounds at "
        f"({pos.get('x')},{pos.get('y')},{pos.get('z')}). "
        f"recent_tuple={json.dumps(signal.recent_tuple)} "
        f"first_round={signal.first_round} last_round={signal.last_round}. "
        f"Steward: this worker is wedged. Consider kanban_reassign / "
        f"kanban_reclaim / `[RESCUE]` card. Whispering via mc chat won't "
        f"unstick — the worker's loop is the same identical tuple. "
        f"Phase 10 PR-S signal."
    )


def emit_comment(task_id: str, body: str, board: Optional[str] = None) -> bool:
    """Shell out to `hermes kanban comment` for cascade-correctness.
    Returns True on success."""
    cmd = ["hermes", "kanban"]
    if board:
        cmd.extend(["--board", board])
    cmd.extend(["comment", task_id, body])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    return proc.returncode == 0


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
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the comment body to stdout instead of shelling out")
    args = ap.parse_args()

    entries = read_progress_tail(args.progress_log, args.rounds)
    signal = detect_auto_stuck(entries, args.rounds, args.pos_tolerance)
    if signal is None:
        return 0
    if args.kanban_db and auto_stuck_already_signaled(args.kanban_db, args.task_id):
        # Already commented — skip to avoid spam.
        return 0
    body = format_comment_body(signal)
    if args.dry_run:
        print(body)
        return 0
    ok = emit_comment(args.task_id, body, board=args.board)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
