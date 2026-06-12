"""Discovery execute graph — explore → seeds → build → farm (outcome-based)."""

from __future__ import annotations

from .constants import DISCOVERY_MIN_WHEAT
from .plan_verify_graph import PLAYBOOK, build_plan_verify_graph
from .predicates import outcome_only_chest
from .wheat_graph import SKILL_BUNDLES, Card, Graph

DEPOSIT_MARK = "wheat_chest"


def build_discovery_graph() -> Graph:
    pv = build_plan_verify_graph()
    plan_cards = pv.cards
    d_cards = (
        Card(
            slug="d001",
            title="[NAV] explore arena",
            assignee="navigator",
            body=(
                "Traverse the discovery arena from `wheat_start`. Sample terrain; "
                "record **pool A** and **pool B** coords + flatness in metadata "
                "`site_candidates` (list of {id, x, y, z, notes}).\n"
                "Use `mc marks` / movement only — no building."
            ),
            depends_on=("pv001",),
            skills=SKILL_BUNDLES["navigator"],
            work_at_mark="wheat_start",
        ),
        Card(
            slug="d002",
            title="harvest grass for seeds",
            assignee="farmer",
            body=(
                "Near the chosen site (planner `farm_plan` or handoff), harvest "
                "grass/tall_grass for wheat_seeds. Top up inventory before plant."
            ),
            depends_on=("pv003",),
            skills=SKILL_BUNDLES["farmer"],
        ),
        Card(
            slug="d003",
            title="level local pad",
            assignee="builder",
            body=(
                "Level a local pad on uneven turf per `farm_plan` / playbook. "
                "Place `farm_water` mark at chosen pool if card requires."
            ),
            depends_on=("d002",),
            skills=SKILL_BUNDLES["builder"],
        ),
        Card(
            slug="d004",
            title="till and plant",
            assignee="farmer",
            body=(
                f"Till/plant per playbook corners — use marks, not hardcoded "
                f"world coords. Schedule harvest reminder like W1 x003."
            ),
            depends_on=("d003",),
            skills=SKILL_BUNDLES["farmer"],
        ),
        Card(
            slug="d005",
            title="harvest and deposit",
            assignee="crafter",
            body=(
                f"Harvest mature wheat; deposit ≥{DISCOVERY_MIN_WHEAT} at "
                f"`:{DEPOSIT_MARK}:` (create mark + chest if playbook says so)."
            ),
            depends_on=("d004",),
            skills=SKILL_BUNDLES["crafter"],
        ),
    )
    # Replace pv002 depends to follow d001 explore
    patched_pv = []
    for c in plan_cards:
        if c.slug == "pv002":
            patched_pv.append(
                Card(
                    slug=c.slug,
                    title=c.title,
                    assignee=c.assignee,
                    body=c.body,
                    depends_on=("d001",),
                    skills=c.skills,
                    work_at_mark=c.work_at_mark,
                    omit_bot_prefix=c.omit_bot_prefix,
                )
            )
        else:
            patched_pv.append(c)
    ordered = (
        patched_pv[0],
        d_cards[0],
        patched_pv[1],
        patched_pv[2],
        *d_cards[1:],
    )
    return Graph(
        epic_slug="d",
        epic_title="[FARM] Wheat discovery",
        epic_body=f"Discovery arena — outcomes in `{PLAYBOOK}`.",
        cards=ordered,
        acceptance_predicate=None,
        acceptance_predicates=outcome_only_chest(
            mark=DEPOSIT_MARK,
            min_count=DISCOVERY_MIN_WHEAT,
        ),
    )
