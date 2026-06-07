"""Wide-flint baseline — the architectural control.

The capstone's job is to test whether the colony chain (one card per
domain) succeeds where a wide single-worker card stalls on the same
work. To be a fair control, the baseline body must be the **same** as
the colony lane's decomposed bodies, concatenated. Anything else
collapses three confounds (multi-card vs wide-catalog vs legacy
assignee) into one knob.

Today's flint profile loads the full skill catalog. We mirror that for
the baseline:
  - assignee: ``pilot-flint`` (proto profile, not the live ``flint``).
  - skills: union of every execute card's skill bundle.
  - bot binding: none (today's flint doesn't have per-card
    ``metadata.bot``; the baseline runs against whatever bot the
    profile's static ``.env`` pins).

The baseline is one card, no chain — it's expected to fail or
no-progress on the multi-domain body. That is the observation we are
making. If it succeeds, A7 is contradicted (the wheat-walkthrough
graph does not expose wide-flint paralysis) — see the plan's confound
table.
"""

from __future__ import annotations

from dataclasses import dataclass

from .wheat_graph import Graph, execute_bodies_concatenated


@dataclass(frozen=True)
class WideBaseline:
    """A single-card baseline derived from a Graph."""

    title: str
    assignee: str
    body: str
    skills: tuple[str, ...]
    # No bot binding — baseline rides whatever the profile pins.
    # acceptance_predicate is the same as the colony graph: same
    # external success criterion, same `mc verify` check.
    acceptance_predicate: dict | None


# The proto profile we install for the baseline. Created by
# capstone/setup.sh (not landed yet — Session 5b prep).
WIDE_PROFILE = "pilot-flint"


def build_wide_baseline(graph: Graph) -> WideBaseline:
    """Build the single-card control for *graph*.

    Skill set is the de-duplicated union of every execute card's
    bundles. Ordering is preserved (first-seen wins) so the rendered
    list reads like the live flint profile's skill list.
    """
    seen: set[str] = set()
    skills: list[str] = []
    for card in graph.cards:
        for s in card.skills:
            if s not in seen:
                seen.add(s)
                skills.append(s)

    return WideBaseline(
        title=graph.epic_title + " (wide flint baseline)",
        assignee=WIDE_PROFILE,
        body=execute_bodies_concatenated(graph),
        skills=tuple(skills),
        acceptance_predicate=graph.acceptance_predicate,
    )
