"""Tests for plan materials → SUPPLY/CONSTRUCT card helpers and filing CLI (E4)."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from scripts.lib.card_body_linter import lint_card_body  # noqa: E402
from scripts.lib.gv2_card_validator import validate_card  # noqa: E402
from scripts.lib.plan_supply import (  # noqa: E402
    materials_for_phase,
    phase_card_bundle,
    resolve_phase_key,
    supply_cards_for_phase,
)

REGISTRY_VERBS = {
    "bot", "checkout", "release", "scene", "observe", "fill", "collect", "deposit",
    "task_context", "construct", "show", "end",
}


class PlanSupplyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        plan_path = REPO / "data" / "ops" / "plans" / "starter_shelter-plan.json"
        cls.plan = json.loads(plan_path.read_text())

    def test_materials_for_l1_slab(self) -> None:
        mats = materials_for_phase(self.plan, "L1_slab")
        self.assertTrue(any(m.get("name") == "cobblestone" for m in mats))

    def test_resolve_phase_from_level(self) -> None:
        self.assertEqual(resolve_phase_key(self.plan, level=1), "L1_slab")

    def test_supply_cards_for_l1(self) -> None:
        cards = supply_cards_for_phase(
            self.plan,
            "L1_slab",
            destination="chest_stone",
        )
        self.assertGreaterEqual(len(cards), 1)
        body = cards[0]["body"]
        self.assertIn("quantity:", body)
        self.assertIn("withdrawable: yes", body)
        self.assertIn("plan: starter_shelter", body)
        self.assertIn("mc bot checkout", body)

    def test_phase_bundle_lints_and_validates(self) -> None:
        bundle = phase_card_bundle(
            self.plan,
            "L1_slab",
            worksite=":shelter:",
            destination="chest_stone",
            anchor_mark="shelter_pad",
        )
        for card in bundle["supply"]:
            lint = lint_card_body(kind="SUPPLY", title=card["title"], body=card["body"])
            self.assertTrue(lint["ok"], lint["errors"])
            val = validate_card(
                title=card["title"],
                body=card["body"],
                assignee="colony-gatherer",
                registry_verbs=REGISTRY_VERBS,
            )
            self.assertTrue(val["ok"], val["errors"])

        c = bundle["construct"]
        lint = lint_card_body(kind="CONSTRUCT", title=c["title"], body=c["body"])
        self.assertTrue(lint["ok"], lint["errors"])
        val = validate_card(
            title=c["title"],
            body=c["body"],
            assignee="colony-builder",
            registry_verbs=REGISTRY_VERBS,
        )
        self.assertTrue(val["ok"], val["errors"])


class ConstructPlanCardsCliTest(unittest.TestCase):
    def test_dry_run_emits_json(self) -> None:
        proc = subprocess.run(
            [
                sys.executable,
                str(REPO / "scripts" / "construct-plan-cards.py"),
                "--plan",
                "starter_shelter",
                "--phase",
                "L1_slab",
                "--worksite",
                ":shelter:",
                "--destination",
                "chest_stone",
                "--dry-run",
            ],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["phase_key"], "L1_slab")
        self.assertGreaterEqual(len(data["supply"]), 1)
        self.assertIn("[CONSTRUCT]", data["construct"]["title"])


if __name__ == "__main__":
    unittest.main()
