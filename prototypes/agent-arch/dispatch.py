#!/usr/bin/env python3
"""Dispatcher stand-in for the agent-arch prototype.

Reads a DSL body file, parses it, and shells out `hermes kanban create`
for each intent, chaining them with `--parent`. Prints the resulting card
IDs.

This is NOT @planner. @planner will eventually live as its own Hermes
profile that wakes on triage events. dispatch.py is the simplest thing
that exercises the parser → kanban create → spawn chain so we can prove
the plumbing.

Usage:

    ./dispatch.py --body-file scenarios/A-single.txt
    ./dispatch.py --body-file scenarios/B-chain.txt --tenant proto-agent-arch
    ./dispatch.py --body-file scenarios/A-single.txt --dry-run

`--dry-run` prints the `hermes kanban create` invocations without running
them, useful when iterating on the parser or the agent → skill mapping.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

# Default HERMES_HOME for the prototype. Phase 0 found that `hermes kanban
# dispatch` is not tenant-scoped, so prototype cards on the shared
# ~/.hermes would get claimed by the live dispatcher. Setup.sh + this
# script use a separate HERMES_HOME by default.
DEFAULT_HERMES_HOME = str(Path.home() / ".hermes-proto-agent-arch")

from dsl_parse import Intent, parse  # noqa: E402

# Map each agent name → (assignee profile, skill bundle for kanban_create).
# Skills must be installed in the assignee profile (setup.sh does this).
AGENT_PROFILE_MAP: dict[str, tuple[str, list[str]]] = {
    "navigator": (
        "pilot-navigator",
        ["agent-navigator", "minecraft-navigation", "minecraft-survival"],
    ),
    "miner": (
        "pilot-miner",
        ["agent-miner", "minecraft-mining", "minecraft-survival"],
    ),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--body-file", required=True, type=Path)
    parser.add_argument("--tenant", default="proto-agent-arch")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print kanban create invocations without executing them",
    )
    parser.add_argument(
        "--max-runtime", default="10m",
        help="Per-card runtime cap (passed to --max-runtime)",
    )
    args = parser.parse_args(argv)

    body = args.body_file.read_text()
    intents = parse(body)
    if not intents:
        print(f"[dispatch] no intents parsed from {args.body_file}", file=sys.stderr)
        return 2

    print(f"[dispatch] parsed {len(intents)} intent(s) from {args.body_file}")

    # Make sure every hermes subprocess sees the isolated home.
    os.environ.setdefault("HERMES_HOME", DEFAULT_HERMES_HOME)
    print(f"[dispatch] HERMES_HOME={os.environ['HERMES_HOME']}")

    prev_id: str | None = None
    card_ids: list[str] = []
    for index, intent in enumerate(intents):
        card_id = create_card(intent, index, prev_id, args)
        if card_id is None and not args.dry_run:
            print(f"[dispatch] aborting chain — card {index} did not return an id", file=sys.stderr)
            return 1
        prev_id = card_id
        if card_id:
            card_ids.append(card_id)
    # Emit a final machine-parseable line so scripts can capture order.
    if card_ids and not args.dry_run:
        print(f"[dispatch] CARDS_IN_ORDER={' '.join(card_ids)}")
    return 0


def create_card(
    intent: Intent, index: int, parent: str | None, args: argparse.Namespace,
) -> str | None:
    mapping = AGENT_PROFILE_MAP.get(intent.agent)
    if mapping is None:
        print(
            f"[dispatch] no profile mapping for @{intent.agent} — "
            f"add it to AGENT_PROFILE_MAP in dispatch.py",
            file=sys.stderr,
        )
        if args.dry_run:
            return f"DRY-{index}"
        return None
    assignee, skills = mapping

    title = intent.body if len(intent.body) <= 60 else intent.body[:57] + "..."

    cmd: list[str] = [
        "hermes", "kanban", "create",
        "--tenant", args.tenant,
        "--assignee", assignee,
        "--body", intent.body,
        "--max-runtime", args.max_runtime,
        "--json",
    ]
    for skill in skills:
        cmd += ["--skill", skill]
    if parent is not None:
        cmd += ["--parent", parent]
    if intent.bot:
        # We can't pass metadata.bot on v0.14 — record it in the body for
        # now (production design has it as metadata.bot once Section F
        # spawn-env injection lands).
        cmd += ["--created-by", f"proto[bot={intent.bot}]"]
    cmd.append(title)

    if args.dry_run:
        print(f"[dispatch] DRY card {index}: {' '.join(_shell_quote(p) for p in cmd)}")
        return f"DRY-{index}"

    print(f"[dispatch] card {index} (@{intent.agent}, bot={intent.bot}): {title}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[dispatch] hermes failed (exit {result.returncode}):\n{result.stderr}",
              file=sys.stderr)
        return None

    return _extract_card_id(result.stdout)


def _extract_card_id(stdout: str) -> str | None:
    # `hermes kanban create --json` returns something like {"id": "...", ...}
    stdout = stdout.strip()
    if not stdout:
        return None
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        print(f"[dispatch] could not parse kanban create output as JSON:\n{stdout}",
              file=sys.stderr)
        return None
    return payload.get("id") or payload.get("task_id") or payload.get("uuid")


def _shell_quote(arg: str) -> str:
    if not arg or any(c in arg for c in ' "\\$`'):
        return "'" + arg.replace("'", "'\\''") + "'"
    return arg


if __name__ == "__main__":
    sys.exit(main())
