"""Translate a wheat-farm Graph into ``hermes kanban create`` calls.

The proto tenant accepts cards via the v0.15 CLI primitive:

  hermes kanban create
      --tenant <name>
      --assignee <slug>
      --body <text>
      --skill <bundle>          (repeatable)
      --parent <card-id>        (repeatable)
      --json
      <title>

For the capstone, every execute card carries ``[bot:<name>]`` as its
title prefix, matching the encoding ``mutex_key.py`` parses on the
kanban side. The author resolves ``depends_on`` slugs into real card
ids — earlier cards in the graph must already have been created.

This module emits **command vectors** (lists of strings) rather than
running them directly. The runner script is responsible for execution
(so dry-run / test paths don't shell out). One module surface keeps
the trial driver thin and the contract testable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Optional

from .wheat_graph import Card, EPIC_BOT, Graph
from .wide_baseline import WideBaseline


DEFAULT_TENANT = "proto-agent-arch"
DEFAULT_MAX_RUNTIME = "30m"  # capstone cards are longer than scenarios A-C


@dataclass(frozen=True)
class Invocation:
    """One ``hermes kanban create`` invocation, parameterised.

    ``slug`` is the graph-local id (echoed for trace + telemetry).
    ``cmd`` is ready to pass to ``subprocess.run``.
    ``depends_on_slugs`` records what graph-local parents this card
    waits on (the author resolves them to real ids at runtime).
    """

    slug: str
    title: str
    cmd: tuple[str, ...]
    depends_on_slugs: tuple[str, ...]


def title_with_bot(bot: str, title: str) -> str:
    """Prefix a title with ``[bot:<name>]`` for the mutex_key parser.

    Idempotent: a title already carrying a tag is returned unchanged.
    """
    stripped = title.lstrip()
    if stripped.lower().startswith("[bot:"):
        return title
    return f"[bot:{bot.lower()}] {title}"


def author_colony_lane(
    graph: Graph,
    *,
    tenant: str = DEFAULT_TENANT,
    max_runtime: str = DEFAULT_MAX_RUNTIME,
    epic_bot: str = EPIC_BOT,
    board: Optional[str] = None,
) -> tuple[Invocation, ...]:
    """Produce one Invocation per execute card in *graph*.

    *board* (optional) — when set, prepends ``--board <name>`` to every
    `hermes kanban` call. Required for runs against live HERMES_HOME
    (~/.hermes) where boards are filesystem-isolated (~/.hermes/kanban/
    boards/<name>/workspaces/). Leave None for the original proto-rig
    behaviour against ~/.hermes-proto-agent-arch (which uses a flat
    workspace layout with no board namespace).

    The epic itself is NOT included — the rig today doesn't create
    epics via the CLI. The depends_on edges are between execute cards;
    the runner resolves slug→id at trial time.

    Title carries ``[bot:<epic_bot>]`` so:
      - mutex_key.py groups the cards into the bot's domain
        (Session 4 semantics), and
      - spawn-with-bot.sh can resolve the same bot from the card title
        when invoked with ``--task-id`` (Session 4½ symmetry).
    """
    invocations: list[Invocation] = []
    for card in graph.cards:
        invocations.append(_invocation_for_card(
            card, epic_bot=epic_bot, tenant=tenant,
            max_runtime=max_runtime, board=board,
        ))
    return tuple(invocations)


def author_wide_baseline(
    baseline: WideBaseline,
    *,
    tenant: str = DEFAULT_TENANT,
    max_runtime: str = DEFAULT_MAX_RUNTIME,
) -> Invocation:
    """Produce the single-card baseline Invocation. No bot binding,
    no parents — wide flint runs the concatenated body as one prompt.
    """
    cmd: list[str] = [
        "hermes", "kanban", "create",
        "--tenant", tenant,
        "--assignee", baseline.assignee,
        "--body", baseline.body,
        "--max-runtime", max_runtime,
        "--json",
    ]
    for skill in baseline.skills:
        cmd += ["--skill", skill]
    cmd.append(baseline.title)

    return Invocation(
        slug="wide001",
        title=baseline.title,
        cmd=tuple(cmd),
        depends_on_slugs=(),
    )


def _invocation_for_card(
    card: Card,
    *,
    epic_bot: str,
    tenant: str,
    max_runtime: str,
    board: Optional[str] = None,
) -> Invocation:
    # Per-card bot binding wins over the graph's epic_bot. Single-bot
    # graphs (wheat) leave Card.bot = None and fall back to epic_bot.
    # Multi-bot graphs (two-bot demo) set Card.bot per card so each
    # card gets its own [bot:<name>] title prefix and lands in its
    # own mutex_key domain.
    bot = card.bot or epic_bot
    title = card.title if card.omit_bot_prefix else title_with_bot(bot, card.title)
    # `hermes kanban [--board <slug>] create …` — board flag sits at the
    # kanban level, before the subcommand. Skip when None.
    cmd: list[str] = ["hermes", "kanban"]
    if board:
        cmd += ["--board", board]
    cmd += [
        "create",
        "--tenant", tenant,
        "--assignee", card.assignee,
        "--body", card.body,
        "--max-runtime", max_runtime,
        "--json",
    ]
    for skill in card.skills:
        cmd += ["--skill", skill]
    # Initial-status override: lets the graph hold a card in `blocked`
    # at creation so a downstream signal (cron unblock, manual review)
    # is required before it ever transitions to ready. Wheat capstone
    # x004 uses this to wait on the harvest-reminder cron.
    if card.initial_status:
        cmd += ["--initial-status", card.initial_status]
    if card.max_retries is not None:
        cmd += ["--max-retries", str(card.max_retries)]
    # `--parent` is added at execution time once we know the real ids
    # of the parents. Storing slugs here keeps the invocation
    # deterministic for tests.
    cmd.append(title)

    return Invocation(
        slug=card.slug,
        title=title,
        cmd=tuple(cmd),
        depends_on_slugs=card.depends_on,
    )


def resolve_parents(
    invocation: Invocation,
    slug_to_id: Mapping[str, str],
) -> tuple[str, ...]:
    """Insert ``--parent <id>`` for each depends_on slug.

    Returns a NEW command tuple — Invocation is immutable. The runner
    calls this just before subprocess execution, once the parent cards'
    real ids are known.

    Raises ``KeyError`` if a depends_on slug has no resolved id — that
    catches dispatcher bugs early instead of letting Hermes complain
    about a missing parent.
    """
    if not invocation.depends_on_slugs:
        return invocation.cmd

    base = list(invocation.cmd)
    # Insert --parent flags BEFORE the final positional title arg.
    title = base[-1]
    head = base[:-1]
    for slug in invocation.depends_on_slugs:
        parent_id = slug_to_id[slug]
        head += ["--parent", parent_id]
    head.append(title)
    return tuple(head)
