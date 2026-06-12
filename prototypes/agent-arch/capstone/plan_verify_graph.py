"""Desk + observe chain: pv001 → pv002 → pv003 (plan-live-verify)."""

from __future__ import annotations

from .predicates import outcome_only_chest
from .wheat_graph import SKILL_BUNDLES, Card, Graph, PLACES

PLAYBOOK = "data/workspace/production/ingest/playbooks/wheat-w1.md"
OBSERVE_SKILLS = (
    "kanban-worker",
    "agent-navigator",
    "minecraft-observe",
)


def build_plan_verify_graph() -> Graph:
    farm = PLACES["farm"]
    cards = (
        Card(
            slug="pv001",
            title="[RESEARCH] plan wheat execute bodies",
            assignee="planner",
            omit_bot_prefix=True,
            body=(
                "Open the wheat playbook and state **outcomes** only: "
                f"min wheat deposit, plot size band (7×7–11×11), must use "
                "one of the two water pools, seeds from field grass.\n"
                f"Read: `{PLAYBOOK}`.\n"
                "List unknowns: pool A vs B, pad leveling on uneven turf, "
                "deposit mark naming. Do not assume a fixed `wheat_plot` mark.\n"
                "metadata.card_kind=research"
            ),
            depends_on=(),
            skills=("kanban-worker", "agent-planner"),
        ),
        Card(
            slug="pv002",
            title="[VERIFY] live blocks @ chosen site",
            assignee="navigator",
            body=(
                f"Read-only observation card. Navigate to the candidate site "
                f"(use `mc inspect --mark {farm}` if mark exists). Run "
                "`mc verify` with predicates from the planner handoff.\n"
                "On complete, include metadata `verify_results` JSON:\n"
                "  observation_source=live_worker, bot=mox, mark, predicates[], "
                "position_at_complete.\n"
                "**Do not** dig, place, till, or harvest."
            ),
            depends_on=("pv001",),
            skills=OBSERVE_SKILLS,
            work_at_mark=farm,
        ),
        Card(
            slug="pv003",
            title="[RESEARCH] finalize plan from verify",
            assignee="planner",
            omit_bot_prefix=True,
            body=(
                "Read child card `pv002` completion metadata (`verify_results`). "
                f"Update `{PLAYBOOK}` with pool choice and a `farm_plan` section "
                "(water_mark, plot_corner1/2, target_farmland_cells, deposit_mark).\n"
                "Optional: write `farm_plan.json` under the trial postmortem dir "
                "if HERMESCRAFT_REPO is set.\n"
                "metadata.card_kind=research"
            ),
            depends_on=("pv002",),
            skills=("kanban-worker", "agent-planner"),
        ),
    )
    return Graph(
        epic_slug="pv",
        epic_title="[PLAN] Wheat plan-live-verify",
        epic_body="Desk chain for W2 plan-live-verify slice.",
        cards=cards,
        acceptance_predicate=None,
        acceptance_predicates=outcome_only_chest(),
    )
