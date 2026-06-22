"""Tests for genesis-v2 worker-card validator."""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

from scripts.lib.gv2_card_validator import (
    has_mining_intent,
    is_gv2_control_card,
    validate_card,
)

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import genesis_lib as gl  # noqa: E402


MINING_BODY = """
anchor: base_anchor
source_truth: mark mine_coal from scout HANDOFF
done_when: 32 coal in chest_coal
mc bot checkout --near base_anchor --cap miner --mark mine_coal
mine_site:
  entry: [100, 64, 200]
  direction: north
  target_y: 12
  resource: coal_ore
  reuse_existing: true
mc mine shaft north 8
mc bot release
"""

VALID_CONSTRUCT = """
anchor: base_anchor
source_truth: scout card t_scout HANDOFF
done_when: 7x7 pad clear at base_anchor
mc bot checkout --near base_anchor --cap builder --mark base_anchor
mc scene
mc observe
footprint: 7x7 at base_anchor
protected_cells: none after survey
mc fill cobblestone 0 64 0 6 64 6
mc bot release
"""

VALID_SUPPLY = """
anchor: base_anchor
source_truth: mark lt_wood_ne from scout HANDOFF
source: mark lt_wood_ne
destination: chest_wood at base_anchor
quantity: 32 oak_log
withdrawable: assume empty inventory + axe at checkout mark
done_when: 32 oak_log deposited in chest_wood
mc bot checkout --near base_anchor --cap gather --mark lt_wood_ne
mc fell_tree 10 20
mc bot release
"""

VALID_SURVEY = """
anchor: spawn 0,64,0
source_truth: genesis spawn coordinate
output_marks: lt_wood_<n>, lt_water_<n>, candidate_pad_<n>
suitability_criteria: surface-only survey; mark flat pads and nearby wood/water
done_when: HANDOFF comment tallies marks created
mc bot checkout --near 0,64,0 --cap scout
mc observe
mc bot release
"""


class MiningIntentTest(unittest.TestCase):
    def test_supply_mine_title_is_mining_intent(self):
        self.assertTrue(has_mining_intent("[SUPPLY] Mine coal for furnace", ""))

    def test_mine_kind(self):
        self.assertTrue(has_mining_intent("[MINE] Coal", ""))

    def test_cook_with_coal_fuel_is_not_mining_intent(self):
        self.assertFalse(
            has_mining_intent(
                "[COOK] Cook raw meat",
                "fuel: coal from chest_food\nmc smelt raw_beef 16\n",
            )
        )

    def test_farm_surface_mine_prose_is_not_mining_intent(self):
        self.assertFalse(
            has_mining_intent(
                "[FARM] Open farm plot with stone border",
                "mine stone from nearby surface for border blocks\nmc till ...\n",
            )
        )
        self.assertFalse(
            has_mining_intent(
                "[FARM] Farm site",
                "mine nearby dirt for plot edges\n",
            )
        )

    def test_supply_gather_title_not_mining_intent(self):
        self.assertFalse(has_mining_intent("[SUPPLY] Gather oak logs", VALID_SUPPLY))

    def test_scout_find_mine_entry_not_mining_intent(self):
        # gv2-2026-06-22-1 FP: a SCOUT card to FIND a mine entry must not require mine_site:.
        self.assertFalse(
            has_mining_intent(
                "[SCOUT] Find safe mine entry — solid ground away from ravine",
                "mc observe\nlocate a spot to open a mine_open shaft later\n",
            )
        )

    def test_construct_shelter_not_mining_intent(self):
        # gv2-2026-06-22-1 FP: CONSTRUCT shelter flagged mining-intent.
        self.assertFalse(
            has_mining_intent(
                "[CONSTRUCT] Shelter 7×7 — cobble shell at base_anchor",
                "footprint: 7x7\nmc scene\nmc fill cobblestone ...\n",
            )
        )

    def test_road_not_mining_intent(self):
        self.assertFalse(
            has_mining_intent("[ROAD] Register road to mine entrance", "mc mark road_to_mine\n")
        )


class ControlExemptTest(unittest.TestCase):
    def test_mission_exempt(self):
        self.assertTrue(is_gv2_control_card("[MISSION] Establish colony", "colony-planner"))

    def test_worker_not_exempt(self):
        self.assertFalse(
            is_gv2_control_card("[GENESIS2:SUPPLY] wood", "colony-gatherer")
        )


class ValidateCardTest(unittest.TestCase):
    def test_valid_mine(self):
        r = validate_card(
            title="[MINE] Open coal",
            body=MINING_BODY,
            assignee="colony-miner",
            registry_verbs={"mine", "checkout", "release", "bot"},
        )
        self.assertTrue(r["ok"], r["errors"])

    def test_valid_supply_requires_schema_fields(self):
        r = validate_card(
            title="[SUPPLY] Gather oak logs",
            body=VALID_SUPPLY,
            assignee="colony-gatherer",
            registry_verbs={"fell_tree", "bot"},
        )
        self.assertTrue(r["ok"], r["errors"])

    def test_supply_mine_missing_site(self):
        body = MINING_BODY
        for line in list(body.splitlines()):
            if line.strip().startswith("mine_site:"):
                body = body.replace(line + "\n  entry:", "")
        body = re.sub(
            r"^\s*mine_site:\s*\n(?:^\s+.+\n)*",
            "",
            body,
            count=1,
            flags=re.MULTILINE,
        )
        r = validate_card(
            title="[SUPPLY] Mine coal",
            body=body,
            assignee="colony-miner",
            registry_verbs=set(),
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("mine_site" in e for e in r["errors"]))

    def test_phantom_stockpile(self):
        r = validate_card(
            title="[SUPPLY] Haul from old stock",
            body=(
                "done_when: 32 oak\n"
                "mc bot checkout --near 0,64,0 --cap gatherer\n"
                "Haul from old stockpile at (10, 64, 10)\n"
                "mc collect oak_log 32\n"
                "mc bot release\n"
            ),
            assignee="colony-gatherer",
            registry_verbs={"collect", "bot"},
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("unverified" in e.lower() or "old stockpile" in e.lower() for e in r["errors"]))

    def test_missing_checkout_release(self):
        r = validate_card(
            title="[SUPPLY] Oak",
            body="done_when: 32 oak\nmc collect oak_log 32\n",
            assignee="colony-gatherer",
            registry_verbs={"collect"},
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("checkout" in e for e in r["errors"]))
        self.assertTrue(any("release" in e for e in r["errors"]))

    def test_missing_anchor_source_truth(self):
        r = validate_card(
            title="[SUPPLY] Gather oak logs",
            body=(
                "source: mark lt_wood_ne\n"
                "destination: chest_wood\n"
                "quantity: 32 oak_log\n"
                "withdrawable: yes\n"
                "done_when: 32 oak_log deposited\n"
                "mc bot checkout --near base_anchor --cap gather\n"
                "mc fell_tree 10 20\n"
                "mc bot release\n"
            ),
            assignee="colony-gatherer",
            registry_verbs={"fell_tree", "bot"},
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("anchor" in e for e in r["errors"]))
        self.assertTrue(any("source_truth" in e for e in r["errors"]))

    def test_supply_missing_v1_fields(self):
        r = validate_card(
            title="[SUPPLY] Gather oak logs",
            body=(
                "anchor: base_anchor\n"
                "source_truth: scout handoff\n"
                "done_when: 32 oak_log deposited\n"
                "mc bot checkout --near base_anchor --cap gather\n"
                "mc fell_tree 10 20\n"
                "mc bot release\n"
            ),
            assignee="colony-gatherer",
            registry_verbs={"fell_tree", "bot"},
        )
        self.assertFalse(r["ok"])
        for field in ("source:", "destination:", "quantity:", "withdrawable:"):
            self.assertTrue(any(field in e for e in r["errors"]), field)

    def test_construct_needs_survey(self):
        r = validate_card(
            title="[CONSTRUCT] Pad",
            body=(
                "done_when: pad flat\n"
                "mc bot checkout --near 0,64,0 --cap builder\n"
                "mc fill dirt 0 64 0 6 64 6\n"
                "mc bot release\n"
            ),
            assignee="colony-builder",
            registry_verbs={"fill", "bot"},
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("survey" in e.lower() or "footprint" in e.lower() for e in r["errors"]))

    def test_construct_scene_only_is_not_enough(self):
        r = validate_card(
            title="[CONSTRUCT] Pad",
            body=(
                "anchor: base_anchor\n"
                "source_truth: scout handoff\n"
                "done_when: pad flat\n"
                "mc bot checkout --near 0,64,0 --cap builder\n"
                "mc scene\n"
                "mc fill dirt 0 64 0 6 64 6\n"
                "mc bot release\n"
            ),
            assignee="colony-builder",
            registry_verbs={"scene", "fill", "bot"},
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("footprint" in e for e in r["errors"]))
        self.assertTrue(any("protected_cells" in e for e in r["errors"]))

    def test_valid_construct(self):
        r = validate_card(
            title="[CONSTRUCT] Pad",
            body=VALID_CONSTRUCT,
            assignee="colony-builder",
            registry_verbs={"scene", "observe", "fill", "bot"},
        )
        self.assertTrue(r["ok"], r["errors"])

    def test_valuable_bridge_material(self):
        r = validate_card(
            title="[SUPPLY] Reach chest",
            body=(
                "done_when: at chest\n"
                "mc bot checkout --near 0,64,0 --cap gatherer\n"
                "route repair: deck oak_log bridge across gap\n"
                "mc bot release\n"
            ),
            assignee="colony-gatherer",
            registry_verbs={"bot"},
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("valuable" in e for e in r["errors"]))

    def test_feedback_exempt_from_worker_fields(self):
        r = validate_card(
            title="[FEEDBACK] Shelter plan",
            body="What footprint would you use?",
            assignee="colony-builder",
            registry_verbs=set(),
        )
        self.assertTrue(r.get("exempt"))
        self.assertTrue(r["ok"])

    def test_valid_survey_template_shape(self):
        r = validate_card(
            title="[SURVEY] [GENESIS2:P1] Scout NE from spawn",
            body=VALID_SURVEY,
            assignee="colony-scout",
            registry_verbs={"observe", "bot"},
        )
        self.assertTrue(r["ok"], r["errors"])

    def test_preseeded_phase1_scout_templates_validate(self):
        data = gl.parse_yaml_simple(REPO / "data" / "genesis-v2" / "templates" / "phase1-cards.yaml")
        for card in data["cards"]:
            with self.subTest(card=card["title"]):
                r = validate_card(
                    title=card["title"],
                    body=card["body"],
                    assignee=card["assignee"],
                )
                self.assertTrue(r["ok"], r["errors"])


class Gv2Run7SupplyRegressionTest(unittest.TestCase):
    """Pin the two SUPPLY failures from gv2-2026-06-21-7 (board_quality.gv2_invalid=2)
    and the corrected mining-SUPPLY form the planner schema now teaches."""

    # Corrected mining-SUPPLY: SUPPLY fields + a mine_site: block (new template form).
    CORRECTED_MINING_SUPPLY = """
anchor: lt_stone_s
source_truth: marks
mc bot checkout --near 53,60,51 --cap miner --mark lt_stone_s
source: mine_open coal_south
destination: chest_stone
quantity: coal 40
withdrawable: yes
mine_site:
  entry: [53, 63, 76]
  direction: south
  target_y: 34
  resource: coal_ore
  reuse_existing: true
done_when: 40 coal in chest_stone
mc stair_down south 8
mc bot release
"""

    def test_corrected_mining_supply_is_valid(self):
        r = validate_card(
            title="[SUPPLY] coal supplement via mine_open coal_south",
            body=self.CORRECTED_MINING_SUPPLY,
            assignee="colony-miner",
            registry_verbs={"stair_down", "bot", "checkout", "release"},
        )
        self.assertTrue(r["ok"], r["errors"])

    def test_mining_supply_without_mine_site_is_invalid(self):
        # The actual -7 coal card: had source/dest/qty/withdrawable but no mine_site:.
        body = self.CORRECTED_MINING_SUPPLY.replace(
            "mine_site:\n"
            "  entry: [53, 63, 76]\n"
            "  direction: south\n"
            "  target_y: 34\n"
            "  resource: coal_ore\n"
            "  reuse_existing: true\n",
            "",
        )
        r = validate_card(
            title="[SUPPLY] coal supplement via mine_open coal_south",
            body=body,
            assignee="colony-miner",
            registry_verbs={"stair_down", "bot", "checkout", "release"},
        )
        self.assertFalse(r["ok"])
        self.assertTrue(any("mine_site" in e for e in r["errors"]), r["errors"])

    def test_miskinded_deposit_card_fails_supply_fields(self):
        # The actual -7 bootstrap card: place-chests + deposit-existing-stock work
        # mis-kinded [SUPPLY] -> missing all four SUPPLY fields.
        body = (
            "anchor: base_anchor\n"
            "source_truth: marks\n"
            "mc bot checkout --near 53,63,49 --cap gatherer --mark base_anchor\n"
            "mc place crafting_table 53,63,45\n"
            "done_when: chests placed and existing stock deposited\n"
            "mc bot release\n"
        )
        r = validate_card(
            title="[SUPPLY] bootstrap chests + deposit wood at base_anchor",
            body=body,
            assignee="colony-gatherer",
            registry_verbs={"place", "bot", "checkout", "release"},
        )
        self.assertFalse(r["ok"])
        for field in ("source:", "destination:", "quantity:", "withdrawable:"):
            self.assertTrue(any(field in e for e in r["errors"]), (field, r["errors"]))


if __name__ == "__main__":
    unittest.main()
