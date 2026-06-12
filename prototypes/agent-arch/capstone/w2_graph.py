"""W2 execute graph — wheat capstone bodies + workspace script hooks."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from .wheat_graph import (
    PLACES,
    SKILL_BUNDLES,
    Card,
    Graph,
    build_default_graph,
)


def _load_artifacts(repo_root: Path) -> dict:
    path = repo_root / "data" / "postmortems" / "wheat-capstone" / "_w2_artifacts.json"
    if not path.is_file():
        return {"scripts": {}, "survey_cache": False}
    return json.loads(path.read_text())


def _script_hook(repo: str, rel: str) -> str:
    return (
        f"\n\n**W2 automation:** Before manual coord work, run:\n"
        f"  `bash $HERMESCRAFT_REPO/{rel}`\n"
        f"(Repo root: `{repo}` or set `HERMESCRAFT_REPO`.)\n"
    )


def build_w2_graph(
    *,
    repo_root: Path,
    cycle: int = 1,
) -> Graph:
    base = build_default_graph()
    art = _load_artifacts(repo_root)
    scripts = art.get("scripts") or {}
    repo = str(repo_root)
    extra_x001 = ""
    extra_x003 = ""
    extra_x004 = ""
    if cycle >= 2 and art.get("survey_cache") and (
        repo_root / "data/workspace/production/data/wheat_survey_cache.json"
    ).is_file():
        extra_x001 = (
            "\n\n**W2 cycle 2+:** `survey_cache` is promoted — read "
            "`data/workspace/production/data/wheat_survey_cache.json` "
            "and skip the full 16×16 re-survey if marks match this fixture.\n"
        )
    if "wheat_plot_bounds.sh" in scripts:
        extra_x003 = _script_hook(repo, "data/workspace/production/scripts/wheat_plot_bounds.sh")
    if "wheat_chest_coords.sh" in scripts:
        extra_x004 = _script_hook(repo, "data/workspace/production/scripts/wheat_chest_coords.sh")

    farm = PLACES["farm"]
    deposit = PLACES["deposit"]
    new_cards: list[Card] = []
    for card in base.cards:
        body = card.body
        if card.slug == "x001":
            body += extra_x001
        elif card.slug == "x003":
            body += extra_x003
        elif card.slug == "x004":
            body += extra_x004
        new_cards.append(
            Card(
                slug=card.slug,
                title=card.title,
                assignee=card.assignee,
                body=body,
                depends_on=card.depends_on,
                skills=card.skills,
                work_at_mark=card.work_at_mark,
                bot=card.bot,
                initial_status=card.initial_status,
                omit_bot_prefix=card.omit_bot_prefix,
            )
        )
    return Graph(
        epic_slug=base.epic_slug,
        epic_title=base.epic_title,
        epic_body=base.epic_body,
        cards=tuple(new_cards),
        acceptance_predicate=base.acceptance_predicate,
        acceptance_predicates=base.acceptance_predicates,
    )
