"""W1 card skill bundles match author output and on-disk skill files."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "prototypes" / "agent-arch"))

from capstone.author import author_colony_lane  # noqa: E402
from capstone.wheat_graph import SKILL_BUNDLES, build_default_graph  # noqa: E402

SKILLS_DIR = REPO_ROOT / "skills"


def _skills_from_cmd(cmd: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(cmd):
        if cmd[i] == "--skill":
            out.append(cmd[i + 1])
        i += 1
    return out


class TestW1CardSkillsContract:
    def test_skill_files_exist_for_every_bundle_entry(self) -> None:
        for assignee, bundle in SKILL_BUNDLES.items():
            for name in bundle:
                if name == "kanban-worker":
                    path = SKILLS_DIR / "kanban-worker.md"
                elif name.startswith("agent-"):
                    path = SKILLS_DIR / f"{name}.md"
                elif name.startswith("minecraft-"):
                    path = SKILLS_DIR / f"{name}.md"
                else:
                    pytest.fail(f"unknown skill token {name!r} for {assignee}")
                assert path.is_file(), f"missing skill file for {name}: {path}"

    def test_author_emits_graph_skill_bundles(self) -> None:
        graph = build_default_graph()
        invocations = author_colony_lane(graph)
        slug_to_card = {c.slug: c for c in graph.cards}
        for inv in invocations:
            card = slug_to_card[inv.slug]
            assert _skills_from_cmd(inv.cmd) == list(card.skills)
            assert list(card.skills) == list(SKILL_BUNDLES[card.assignee])
