"""Proc-nav Core graph — planner / navigator / observe handoff (five slugs)."""

from __future__ import annotations

from .plan_verify_graph import OBSERVE_SKILLS
from .wheat_graph import SKILL_BUNDLES, Card, Graph

PLAYBOOK = "reports/agent-arch/proc-nav-scout-runbook.md"


def build_proc_scout_graph() -> Graph:
    nav_skills = (
        "kanban-worker",
        "agent-navigator",
        "minecraft-navigation",
    )
    cards = (
        Card(
            slug="pn-plan",
            title="[RESEARCH] proc-nav anchor playbook",
            assignee="planner",
            omit_bot_prefix=True,
            body=(
                "Read `data/runtime/last-scenario-map.json` (or trial manifest) and "
                f"draft a short playbook section in `{PLAYBOOK}` citing **seed** and "
                "anchor names: spawn, muster, overlook, return_post.\n"
                "No `mc` on this card.\n"
                "metadata.card_kind=research"
            ),
            depends_on=(),
            skills=("kanban-worker", "agent-planner"),
        ),
        Card(
            slug="pn-nav-1",
            title="[NAV] reach overlook",
            assignee="navigator",
            body=(
                "Reach mark **`:overlook:`** (or `mc inspect --mark overlook`) within "
                "**4 blocks**. Run **`mc scene` ≥ 1** before completing.\n"
                "On complete include metadata `anchors_reached: [overlook]` and "
                "`exit_pos` from `mc status`."
            ),
            depends_on=("pn-plan",),
            skills=nav_skills,
            work_at_mark="overlook",
        ),
        Card(
            slug="pn-nav-2",
            title="[NAV] reach return post",
            assignee="navigator",
            body=(
                "From overlook area, reach **`:return_post:`** within **4 blocks** using "
                "`mc go_mark` or `mc move` / `mc goto` — not chat-only navigation.\n"
                "metadata `anchors_reached` should include return_post."
            ),
            depends_on=("pn-nav-1",),
            skills=nav_skills,
            work_at_mark="return_post",
        ),
        Card(
            slug="pn-observe",
            title="[VERIFY] live anchors",
            assignee="navigator",
            body=(
                "Read-only observation. `mc inspect --mark` on overlook or return_post; "
                "run `mc verify` with at least one predicate.\n"
                "On complete include metadata **`verify_results`** JSON:\n"
                "  observation_source=live_worker, bot=mox, mark, predicates[], "
                "position_at_complete.\n"
                "**Do not** dig, place, or modify terrain."
            ),
            depends_on=("pn-nav-2",),
            skills=OBSERVE_SKILLS,
            work_at_mark="overlook",
        ),
        Card(
            slug="pn-plan-2",
            title="[RESEARCH] finalize from verify",
            assignee="planner",
            omit_bot_prefix=True,
            body=(
                "Read child `pn-observe` completion metadata (`verify_results`). "
                f"Update notes in `{PLAYBOOK}` or kanban comment referencing predicates.\n"
                "metadata.card_kind=research"
            ),
            depends_on=("pn-observe",),
            skills=("kanban-worker", "agent-planner"),
        ),
    )
    return Graph(
        epic_slug="pn",
        epic_title="[NAV] Proc-scout discovery",
        epic_body="Core proc-nav kanban lane on proc-nav-lab / Mox.",
        cards=cards,
        acceptance_predicate=None,
        acceptance_predicates=(),
    )
