"""``hermes landfolk gate-check`` CLI subcommand.

Invoked by ``scripts/landfolk-dispatcher.sh`` once per dispatcher tick,
before ``hermes kanban dispatch``. Idempotent; safe to run on demand
from a terminal too.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import config
from .gate import format_stats, gate_check
from .log import write_dispatcher_log


def setup(parser: argparse.ArgumentParser) -> None:
    """Add ``hermes landfolk <verb>`` subcommands to *parser*."""
    sub = parser.add_subparsers(dest="action", required=True, metavar="VERB")

    g = sub.add_parser(
        "gate-check",
        help="Run one per-assignee mutex enforcement pass on the kanban board.",
        description=(
            "Idempotent SQL pass: releases stale orchestrator + mutex "
            "locks, parks orchestrator cards via orch_continuous:<assignee>, "
            "parks excess ready siblings via mutex_park:<assignee>, and "
            "promotes next-best todo for idle assignees. Run by the "
            "landfolk dispatcher each tick before `hermes kanban dispatch`."
        ),
    )
    g.add_argument(
        "--board",
        default=config.BOARD,
        help=f"Board to operate on (default: {config.BOARD}, from $LANDFOLK_BOARD)",
    )
    g.add_argument(
        "--json",
        action="store_true",
        help="Emit the stats dict as JSON on stdout (default: silent unless --verbose).",
    )
    g.add_argument(
        "--verbose",
        action="store_true",
        help="Print the one-line summary to stdout in addition to logging.",
    )
    g.set_defaults(func=_run_gate_check)


def handle(args: argparse.Namespace) -> int:
    """Dispatch handler — argparse calls this via ``args.func``."""
    func = getattr(args, "func", None)
    if func is None:
        print("landfolk: no action specified (try `hermes landfolk gate-check`)", file=sys.stderr)
        return 2
    return func(args)


def _run_gate_check(args: argparse.Namespace) -> int:
    if config.DISABLE_GATE:
        write_dispatcher_log("orch: gate disabled via LANDFOLK_DISABLE_GATE")
        if args.json:
            print(json.dumps({"disabled": True}))
        return 0

    # Local import keeps plugin module load cheap even if Hermes isn't
    # importable from the script's context (e.g. some test environments).
    try:
        from hermes_cli.kanban_db import connect
    except ImportError as exc:
        print(f"landfolk gate-check: could not import hermes_cli.kanban_db: {exc}", file=sys.stderr)
        return 1

    try:
        conn = connect(board=args.board)
    except Exception as exc:  # noqa: BLE001
        print(f"landfolk gate-check: failed to open board '{args.board}': {exc}", file=sys.stderr)
        return 1

    try:
        stats = gate_check(conn)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass

    line = format_stats(stats)
    # Only log when something happened — quiet ticks stay quiet.
    if any(stats.get(k, 0) for k in ("promoted", "demoted", "orch_parked", "orch_released", "errors")):
        write_dispatcher_log(line)

    if args.json:
        print(json.dumps(stats))
    elif args.verbose:
        print(line)

    return 0 if stats.get("errors", 0) == 0 else 1
