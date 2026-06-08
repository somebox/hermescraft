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

# Places used by the cards. Mark names are deliberately INERT — no
# directional words — so the agent can't infer position from the name.
# Trial 1780840853 failed because `field_south` was read by the agent
# as "south of base", priming a phantom destination. The fixture
# (`data/test-fixtures/colony/wheat_capstone.yaml`) is the canonical
# source for the actual coords; the agent must `mc inspect --mark <n>`
# to read them, not guess from the name.
PLACES = {
    "farm": "wheat_plot",
    "deposit": "wheat_chest",
    "home": "wheat_start",
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
    # Optional initial-status override. When set (e.g. "blocked"), the
    # author passes `--initial-status <value>` to `hermes kanban create`
    # so the card starts in that state regardless of its dependency
    # situation. Used by wheat capstone x004 to wait on the
    # harvest-reminder cron before the agent can claim it.
    initial_status: Optional[str] = None


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
    # Single predicate — backwards-compat, fed to `acceptance.evaluate`.
    # The two-bot demo uses this exclusively.
    acceptance_predicate: Optional[dict] = None
    # Multi-predicate set — fed to `acceptance.evaluate_all`. Used by
    # the wheat capstone for the full walkthrough acceptance (plot,
    # crop, water, sign). All must satisfy for the scorecard to pass.
    acceptance_predicates: Optional[list[dict]] = None


# Skill bundles per assignee. These reference real skill files under
# ``skills/`` at the repo root. The preflight gate confirms each named
# file exists before authorising the trial.
SKILL_BUNDLES: dict[str, tuple[str, ...]] = {
    "navigator": (
        "kanban-worker",
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
        "kanban-worker",
        "agent-builder",
        "minecraft-building",
        "minecraft-survival",
    ),
    "farmer": (
        "kanban-worker",
        "agent-farmer",
        "minecraft-farming",
        "minecraft-survival",
    ),
    "crafter": (
        "kanban-worker",
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

    # Body conventions (informed by trial 1780840853 postmortem):
    #
    #   - Always tell the agent to `mc inspect --mark <name>` BEFORE
    #     navigating. Mark names are opaque labels; the coords are
    #     read from inspect, not inferred from the name.
    #   - Be explicit about the mark name (no "the field" — name it).
    #   - Spell out the 9×9 dimensions for till + plant (the agent
    #     doesn't read PLACES.farm semantics).
    cards = (
        Card(
            slug="x001",
            title="nav survey",
            assignee="navigator",
            body=(
                f"Use `mc inspect --mark {farm}` to read the wheat-plot "
                f"coordinates. Note: `{farm}` resolves to the center "
                f"**water source block** — approach via an adjacent dirt "
                f"cell (`mc move <x> 65 <z>` to the dirt one block off, "
                f"or `mc goto_near {farm} 2`). Then survey the "
                f"immediate 16×16 area for a flat farm pad."
            ),
            depends_on=(),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark=farm,
        ),
        Card(
            slug="x002",
            title="build pad",
            assignee="builder",
            body=(
                f"Use `mc inspect --mark {farm}` to read the wheat-plot "
                f"coordinates. Level a 16×16 pad centered on the mark, "
                f"per the navigator's handoff. If the pad is already "
                f"flat dirt, mark this done."
            ),
            depends_on=("x001",),
            skills=SKILL_BUNDLES["builder"],
            work_at_mark=farm,
        ),
        Card(
            slug="x003",
            title="plant + schedule harvest",
            assignee="farmer",
            body=(
                f"Use `mc inspect --mark {farm}` to read the wheat-plot "
                f"coordinates. Till a 9×9 area centered on the mark, "
                f"then plant wheat in every cell. A water source is "
                f"already at the mark's exact coord — leave it alone.\n\n"
                f"After planting is complete, schedule the harvest "
                f"reminder so the harvest card unblocks once the wheat "
                f"is mature. The harvest card is the only card on the "
                f"wheat-capstone board that's in `blocked` status; find "
                f"its task id with: "
                f"`hermes kanban --board wheat-capstone list --status "
                f"blocked --json`. Then:\n\n"
                f"  1. `mkdir -p $HERMES_HOME/state && echo <task_id> > "
                f"$HERMES_HOME/state/wheat-harvest-pending.txt`\n"
                f"  2. `hermes cron create '30s' --no-agent "
                f"--script wheat-harvest-reminder.sh "
                f"--name 'wheat-harvest-reminder'`\n\n"
                f"Verify both succeeded (state file exists; "
                f"`hermes cron list` shows the new job), then "
                f"complete this card. The reminder fires once at +30s "
                f"and unblocks the harvest card."
            ),
            depends_on=("x002",),
            skills=SKILL_BUNDLES["farmer"],
            work_at_mark=farm,
        ),
        Card(
            slug="x004",
            title="harvest + deposit",
            assignee="crafter",
            initial_status="blocked",
            body=(
                f"The wheat at :{farm}: should be mature now — this "
                f"card was unblocked by the harvest reminder cron. "
                f"Use `mc inspect --mark {farm}` to confirm coords, "
                f"then harvest the 9×9 wheat plot with `mc collect "
                f"wheat 80` (or equivalent — your @crafter bundle has "
                f"the verb).\n\n"
                f"Once harvested, use `mc inspect --mark {deposit}` "
                f"to read the storage chest coordinates (the chest sits "
                f"on the walkable pad south of the plot — stand adjacent "
                f"for `mc deposit`). Deposit all wheat into it.\n\n"
                f"Finally, clean up the reminder cron job (it has "
                f"already fired but is still listed). "
                f"`hermes cron list` will show any job whose name "
                f"starts with `wheat-harvest-reminder`; remove each "
                f"with `hermes cron remove <id>`. This keeps "
                f"`$HERMES_HOME/cron/jobs.json` tidy for the next trial."
            ),
            depends_on=("x003",),
            skills=SKILL_BUNDLES["crafter"],
            work_at_mark=deposit,
        ),
    )

    # Single-predicate acceptance (kept for `acceptance.evaluate`'s
    # backward-compat path + the simplest scorecard reading): wheat
    # actually deposited in the chest is the cheapest end-to-end proof.
    acceptance_predicate = {
        "kind": "chest_contains",
        "mark": deposit,
        "item": "wheat",
        "min_count": 12,  # walkthrough §Scenario tolerance band
    }

    # Multi-predicate acceptance (consumed by `acceptance.evaluate_all`):
    # the full walkthrough acceptance set per example-wheat-farm-walk
    # through.md "Spec on epic" — 9×9 tilled + planted, water source,
    # sign at the field center. Predicate kinds all in SUPPORTED_KINDS
    # (verbs added during two-bot trial 2 prep gap 2: at_mark + region_
    # blocks).
    #
    # The corner coords below are PLACEHOLDERS — the real values come
    # from the fixture's :field_south: definition. Session 5b's runner
    # is expected to re-bind these from the fixture's known mark
    # coords before invoking `evaluate_all`. Keeping them here makes
    # the shape obvious; the README + runbook tell the operator to
    # patch them.
    acceptance_predicates = [
        # ── 9×9 plot of farmland at Y=64 (the dirt layer post-till) ──
        # 81 cells minus tolerance for the water source cell + a few
        # till-misses. Set min_count=72 to allow ~10% loss.
        {
            "kind": "region_blocks",
            "corner1": {"x": -54, "y": 64, "z": 46},  # PLACEHOLDER
            "corner2": {"x": -46, "y": 64, "z": 54},  # PLACEHOLDER
            "block": "farmland",
            "min_count": 72,
        },
        # ── Wheat deposited in the chest (post-harvest end-state) ──
        # The previous in-field wheat predicate (`region_blocks block=wheat`
        # min_count=60) checked a state the crafter card is supposed to
        # ELIMINATE — wheat in the field after harvest is 0 by design.
        # The honest end-state proof is "the crafter dropped wheat into
        # wheat_chest." min_count=30 = ~37% of the 81-cell plot — a
        # generous lower bound that accounts for wheat that wasn't mature
        # at harvest time (random tick + crafter timing) without flattering
        # a half-finished trial. Empirically w1-1780879052 deposited 40.
        {
            "kind": "chest_contains",
            "mark": deposit,
            "item": "wheat",
            "min_count": 30,
        },
        # ── Water source at the field center ──
        # Walkthrough convention: water replaces farmland at one cell
        # inside the plot. Without a water source within 4 blocks of
        # any plot tile, wheat can't grow — so this predicate doubles
        # as a sanity check on the till+plant cards' water-management.
        {
            "kind": "at_mark",
            "mark": "wheat_plot",  # fixture POSTs this to BOTH bots; Tester is queried by verify
            "block": "water",
        },
    ]

    return Graph(
        epic_slug="e001",
        epic_title=f"[FARM] Wheat at :{farm}:",
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
        acceptance_predicates=acceptance_predicates,
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
