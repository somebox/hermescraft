"""DSL parser for the agent-architecture prototype.

Parses card bodies that look like:

    @navigator pip to :mine_nw:
    @miner pip extract 32 iron at :mine_nw:
    @navigator pip return to :base_anchor:
    @planner read base-goals.yaml and write triage cards

Each line that starts with `@` becomes one Intent. Other lines are ignored.

Spec source: docs/architecture/hermes-agents.md (shapes 1 and 2),
docs/architecture/hermes-v0.15-reference.md "Our usage" notes on @mention.

This is hermescraft-built. Hermes itself does not parse @mentions
(verified against upstream source — see hermes-v0.15-reference.md).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Bots registered in the world. The second whitespace-separated token after
# `@<agent>` is treated as a bot only if it matches one of these. Otherwise
# the whole rest of the line is the body and the intent is bot-less.
#
# Target roster per docs/architecture/bots-and-mc.md § Target fleet roster.
# Legacy names (flint, mason, gatherer, barley, steward) intentionally NOT
# listed — the new model uses the target roster.
KNOWN_BOTS = frozenset({"pip", "mox", "zee", "bix", "glim"})

MARK_RE = re.compile(r":([a-z][a-z0-9_]*):")
LINE_RE = re.compile(r"^@(\w+)\s+(.+?)\s*$")


@dataclass
class Intent:
    agent: str
    bot: str | None
    body: str
    marks: list[str] = field(default_factory=list)

    def to_kanban_create_args(
        self,
        skills: list[str],
        parent: str | None = None,
        assignee_prefix: str = "pilot-",
    ) -> list[str]:
        """Render this intent as `hermes kanban create` CLI args.

        The assignee prefix is "pilot-" by default for the prototype. Real
        production cards would use bare agent names once Section F's spawn-env
        injection trick ships (see docs/architecture/impact.md § F).
        """
        title = self.body if len(self.body) <= 60 else self.body[:57] + "..."
        args = [
            "--assignee", f"{assignee_prefix}{self.agent}",
            "--title", title,
            "--body", self.body,
        ]
        for skill in skills:
            args += ["--skill", skill]
        if parent is not None:
            args += ["--parent", parent]
        return args


def parse(text: str, known_bots: frozenset[str] = KNOWN_BOTS) -> list[Intent]:
    """Walk lines, emit one Intent per `@<agent>` line.

    Lines starting with `#` are comments and ignored. Blank lines are ignored.
    Lines that don't start with `@` are ignored (silent — matches the @planner
    fall-through pattern described in hermes-agents.md).
    """
    intents: list[Intent] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if not line.startswith("@"):
            continue
        match = LINE_RE.match(line)
        if not match:
            continue
        agent, rest = match.groups()
        # Try to split a known bot off the front of the rest.
        bot, body = _split_bot(rest, known_bots)
        marks = MARK_RE.findall(body)
        intents.append(Intent(agent=agent, bot=bot, body=body, marks=marks))
    return intents


def _split_bot(rest: str, known_bots: frozenset[str]) -> tuple[str | None, str]:
    """If `rest` starts with a known bot token, return (bot, remaining body).
    Otherwise return (None, rest)."""
    parts = rest.split(maxsplit=1)
    if not parts:
        return None, rest
    first = parts[0].lower()
    if first in known_bots:
        body = parts[1] if len(parts) > 1 else ""
        return first, body
    return None, rest
