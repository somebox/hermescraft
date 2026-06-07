"""Canonical wheat-farm card graph for the colony lane.

Derived from ``docs/architecture/example-wheat-farm-walkthrough.md``,
restricted to what the proto rig can actually run:

  - Only the four **execute** cards (the bot lane). Plan / research /
    overseer / clarify / doc are walkthrough-doc concerns that need
    profiles and skill bundles outside the rig's current surface.
  - Each card is hand-bound to ``mox`` via the ``[bot:mox]`` title
    prefix — the same encoding ``mutex_key.py`` parses, so the cards
    serialize per Session 4's contract.
  - Acceptance is narrowed to a ``chest_contains``-expressible
    predicate (wheat deposited into ``:chest_food:``). The walkthrough's
    richer set (tilled-plot grid, water source, sign) needs verify
    verbs not yet landed; see ``acceptance.py``.

This module is **data only** — no I/O. The graph is consumed by
``author.py`` (to create cards) and ``acceptance.py`` (to verify
done-ness).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

# Bot binding for the entire epic. Matches the walkthrough's
# "Execute (Mox lane — assignee rotates)" section.
EPIC_BOT = "mox"

# Places used by the cards. These are mark names; the colony test
# arena fixture (`data/test-fixtures/colony/`) is the canonical source
# for whether they exist in-world. The capstone preflight checks
# their presence.
PLACES = {
    "farm": "field_south",
    "deposit": "chest_food",
    "home": "base_anchor",
}


@dataclass(frozen=True)
class Card:
    """One execute card in the colony lane.

    ``slug`` is a graph-local identifier (e.g. ``x001``); the real card
    id is assigned by Hermes on create and tracked by ``author.py``.

    ``depends_on`` references other slugs in the same graph. The
    author resolves these to real card ids before passing them to
    ``hermes kanban create --parent``.

    ``bot`` is the per-card bot binding for multi-bot graphs (e.g. the
    two-bot demo). When None, the author falls back to the graph's
    ``epic_bot`` — preserving wheat's single-bot binding behaviour.
    Concrete value (e.g. "pip") becomes the ``[bot:<name>]`` title
    prefix on the kanban side and is what mutex_key.py parses.
    """

    slug: str
    title: str  # human-readable; ``[bot:<name>]`` prefix added by author
    assignee: str
    body: str
    depends_on: tuple[str, ...] = ()
    skills: tuple[str, ...] = ()
    work_at_mark: Optional[str] = None
    bot: Optional[str] = None


@dataclass(frozen=True)
class Graph:
    """The full colony graph for a single capstone run.

    The execute cards must be returned in a topologically-valid order
    so the author can chain ``--parent`` references without forward
    references.
    """

    epic_slug: str
    epic_title: str
    epic_body: str
    cards: tuple[Card, ...] = field(default_factory=tuple)
    acceptance_predicate: Optional[dict] = None  # consumed by acceptance.py


# Skill bundles per assignee. These reference real skill files under
# ``skills/`` at the repo root. The preflight gate confirms each named
# file exists before authorising the trial.
SKILL_BUNDLES: dict[str, tuple[str, ...]] = {
    "navigator": (
        "agent-navigator",
        "minecraft-navigation",
        "minecraft-survival",
    ),
    # Builder + farmer + crafter agent-* bundles do not exist yet
    # (the walkthrough names them; they're an open architecture item).
    # For the first capstone trial we either land them as a separate
    # session OR use the closest available proxy. The scaffold lists
    # the canonical names so preflight surfaces the gap clearly.
    "builder": (
        "agent-builder",
        "minecraft-building",
        "minecraft-survival",
    ),
    "farmer": (
        "agent-farmer",
        "minecraft-farming",
        "minecraft-survival",
    ),
    "crafter": (
        "agent-crafter",
        "minecraft-chores",
        "minecraft-survival",
    ),
}


def build_default_graph() -> Graph:
    """The minimal four-card execute lane from the walkthrough.

    Bodies are deliberately short — production-grade bodies belong to
    the playbook (referenced from the walkthrough but not loaded by the
    scaffold). The capstone is testing whether the *shape* (one card per
    domain) succeeds where a single wide-body card would stall, so the
    bodies are sized like the walkthrough's "Spec on epic" list.
    """
    farm = PLACES["farm"]
    deposit = PLACES["deposit"]

    cards = (
        Card(
            slug="x001",
            title="nav survey",
            assignee="navigator",
            body=f"Go to :{farm}: and survey a 16x16 area for a flat farm pad.",
            depends_on=(),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=farm,
        ),
        Card(
            slug="x002",
            title="build pad",
            assignee="builder",
            body=f"Level a 16x16 pad at :{farm}: per nav survey handoff.",
            depends_on=("x001",),
            skills=SKILL_BUNDLES["builder"],
            work_at_mark=farm,
        ),
        Card(
            slug="x003",
            title="plant",
            assignee="farmer",
            body=f"Till and plant wheat 9x9 at :{farm}:. Water source within reach.",
            depends_on=("x002",),
            skills=SKILL_BUNDLES["farmer"],
            work_at_mark=farm,
        ),
        Card(
            slug="x004",
            title="deposit",
            assignee="crafter",
            body=f"Deposit harvested wheat at :{deposit}:.",
            depends_on=("x003",),
            skills=SKILL_BUNDLES["crafter"],
            work_at_mark=deposit,
        ),
    )

    # Narrowed acceptance — what current `mc verify` can express. The
    # walkthrough's full set (tilled plots, water source, sign) needs
    # region/at_mark verbs that haven't landed. See acceptance.py.
    acceptance_predicate = {
        "kind": "chest_contains",
        "mark": deposit,
        "item": "wheat",
        "min_count": 12,  # 3 plots of 4 wheat per walkthrough §Scenario
    }

    return Graph(
        epic_slug="e001",
        epic_title="[FARM] Wheat at :field_south:",
        epic_body=(
            "Spec:\n"
            "- Survey 16x16 at places.farm\n"
            "- Level pad at places.farm\n"
            "- Till and plant wheat 9x9 at places.farm\n"
            "- Deposit surplus wheat at places.deposit\n"
            f"places.farm = :{farm}:; places.deposit = :{deposit}:\n"
            f"metadata.bot = {EPIC_BOT}\n"
        ),
        cards=cards,
        acceptance_predicate=acceptance_predicate,
    )


def execute_bodies_concatenated(graph: Graph) -> str:
    """Return the wide-baseline body: every execute card's body
    concatenated into a single prompt. Used by ``wide_baseline.py``.

    This is the architecturally honest control: same work expressed
    as one prompt to one wide worker rather than four narrow ones.
    """
    return "\n\n".join(
        f"Step {i + 1} ({c.assignee}): {c.body}"
        for i, c in enumerate(graph.cards)
    )
