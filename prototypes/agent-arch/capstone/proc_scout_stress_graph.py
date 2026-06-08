"""Proc-nav Stress graph — go_mark tour, escape doctrine, muster stop."""

from __future__ import annotations

from .proc_scout_graph import PLAYBOOK, build_proc_scout_graph
from .wheat_graph import Card, Graph

NAV_STRESS_BODY_1 = (
    "Approach **overlook** using **`mc go_mark` only** (no raw coords in chat). "
    "On `NAV_BLOCKED` / `BOT_TRAPPED`, run **`mc reachable`** then **`mc escape` "
    "or `mc build_stairs`** per navigation skill hints before retry.\n"
    "`mc scene` ≥ 1; metadata `anchors_reached: [overlook]`."
)

NAV_STRESS_BODY_2 = (
    "Three-stop tour: **overlook → muster → return_post**, each within **4 blocks**. "
    "Prefer `go_mark` between stops. metadata lists all three in `anchors_reached`."
)

OBSERVE_STRESS_BODY = (
    "Read-only verify. `mc verify` predicates must include at least one "
    "**at_mark**-style self-check.\n"
    "On complete: **`verify_results`** with observation_source=live_worker."
)


def build_proc_scout_stress_graph() -> Graph:
    core = build_proc_scout_graph()
    patched: list[Card] = []
    for c in core.cards:
        if c.slug == "pn-nav-1":
            patched.append(
                Card(
                    slug=c.slug,
                    title=c.title,
                    assignee=c.assignee,
                    body=NAV_STRESS_BODY_1,
                    depends_on=c.depends_on,
                    skills=c.skills,
                    work_at_mark=c.work_at_mark,
                )
            )
        elif c.slug == "pn-nav-2":
            patched.append(
                Card(
                    slug=c.slug,
                    title=c.title,
                    assignee=c.assignee,
                    body=NAV_STRESS_BODY_2,
                    depends_on=c.depends_on,
                    skills=c.skills,
                    work_at_mark="muster",
                )
            )
        elif c.slug == "pn-observe":
            patched.append(
                Card(
                    slug=c.slug,
                    title=c.title,
                    assignee=c.assignee,
                    body=OBSERVE_STRESS_BODY,
                    depends_on=c.depends_on,
                    skills=c.skills,
                    work_at_mark=c.work_at_mark,
                )
            )
        else:
            patched.append(c)
    return Graph(
        epic_slug=core.epic_slug,
        epic_title="[NAV] Proc-scout stress",
        epic_body=f"Stress tour on proc-nav — see `{PLAYBOOK}`.",
        cards=tuple(patched),
        acceptance_predicate=core.acceptance_predicate,
        acceptance_predicates=core.acceptance_predicates,
    )
