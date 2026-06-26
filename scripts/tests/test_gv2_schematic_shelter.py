"""Unit tests for gv2 starter_shelter schematic bootstrap helpers."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from scripts.lib.gv2_card_validator import validate_card  # noqa: E402
from scripts.lib.gv2_schematic_shelter import (  # noqa: E402
    _construct_body_for_phase,
    file_starter_shelter_sequence,
    footprint_min_from_base_anchor,
    patch_starter_shelter_plan,
    shelter_chests_card_body,
    verify_card_body,
)
from scripts.lib.plan_supply import phase_record, supply_cards_for_phase  # noqa: E402


class Gv2SchematicShelterTest(unittest.TestCase):
    def test_footprint_min_from_base_anchor(self) -> None:
        base = {"x": 53, "y": 65, "z": 49}
        self.assertEqual(footprint_min_from_base_anchor(base), (50, 64, 46))

    def test_patch_starter_shelter_plan_writes_anchor(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            base = {"x": 10, "y": 65, "z": 10}
            plan = patch_starter_shelter_plan(REPO, data, base)
            self.assertEqual(plan["anchor"]["coords"], [7, 64, 7])
            out = data / "ops" / "plans" / "starter_shelter-plan.json"
            self.assertTrue(out.is_file())
            loaded = json.loads(out.read_text())
            self.assertEqual(loaded["anchor"]["coords"], [7, 64, 7])


    def test_file_sequence_uses_real_cli_verbs_and_flags(self) -> None:
        """Regression: the bootstrap must speak the ACTUAL hermes kanban CLI.

        gv2-2026-06-24-2 failed every poller cycle ('kanban failed: usage:
        hermes kanban ...') because this sequence used an imaginary CLI: verb
        `add` (real verb is `create`), `--for` (no such flag — epic membership
        is a body trailer), `--after` (no such flag — ordering is a `link`
        edge), and `edit --body` (edit can't set a body). Lock the contract."""
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            base = {"x": 10, "y": 65, "z": 10}
            plan = patch_starter_shelter_plan(REPO, data, base)

            calls: list[list[str]] = []
            counter = {"n": 0}

            def kanban_run(args: list[str]) -> dict:
                calls.append(list(args))
                if args and args[0] == "create":
                    counter["n"] += 1
                    return {"id": f"t_{counter['n']:03d}"}
                return {}

            created = file_starter_shelter_sequence(
                kanban_run,
                plan=plan,
                epic_for="t_epic_p1",
                base_anchor=base,
            )

            creates = [c for c in calls if c and c[0] == "create"]
            links = [c for c in calls if c and c[0] == "link"]

            # Never the imaginary verb / flags.
            self.assertTrue(all(c[0] != "add" for c in calls), "no `add` verb")
            self.assertFalse(any("--for" in c for c in calls), "no --for flag")
            self.assertFalse(any("--after" in c for c in calls), "no --after flag")
            self.assertFalse(
                any(c and c[0] == "edit" for c in calls),
                "no `edit` (CLI edit can't set a body)",
            )

            # 4 phases, each with 1 construct + 1 verify (supply count is
            # data-driven), plus 1 chest card. >= 4 + 4 + 1 creates.
            self.assertGreaterEqual(len(creates), 9)
            self.assertEqual(len(created["phases"]), 4)
            for ph in created["phases"]:
                self.assertTrue(ph["construct_id"], "phase missing construct_id")
                self.assertTrue(ph["verify_id"], "phase missing verify_id")
            self.assertTrue(created["chest_card"])

            # Epic membership rides in the body trailer, not a flag/link.
            for c in creates:
                body = c[c.index("--body") + 1]
                self.assertIn("epic: t_epic_p1", body,
                              f"create missing epic trailer: {c[1][:40]}")
                # Construct bodies must NOT carry a literal --card (worker uses
                # HERMES_KANBAN_TASK); they auto-resolve their own id.
                if "[CONSTRUCT]" in c[1] and "task_context set" in body:
                    self.assertNotIn("--card t_", body)

            # Ordering is expressed as link edges (prereq chain), and every
            # link target is a real created id.
            self.assertGreaterEqual(len(links), len(creates) - 1)
            created_ids = {f"t_{i:03d}" for i in range(1, counter["n"] + 1)}
            for ln in links:
                self.assertEqual(len(ln), 3, f"link arity: {ln}")
                self.assertIn(ln[1], created_ids)
                self.assertIn(ln[2], created_ids)

    def test_construct_body_is_phase_aware_blocks(self) -> None:
        """gv2-2026-06-24-8: the construct body hardcoded `mc fill cobblestone` for
        EVERY phase. L0_ground has 0 plan cells (level/drain) so the workset was empty
        ("49 denied"); L3/L4 would fill the wrong block. Body must be phase-aware:
        L0 = no fill (prep); L1/L3/L4 = fill their ACTUAL block."""
        from scripts.lib.gv2_schematic_shelter import _construct_body_for_phase
        with tempfile.TemporaryDirectory() as tmp:
            plan = patch_starter_shelter_plan(REPO, Path(tmp), {"x": -159, "y": 71, "z": -244})
        def body(pk, final=False):
            return _construct_body_for_phase(plan, pk, worksite=":shelter:",
                anchor_mark="base_anchor", checkout_near="-159 71 -244", final_phase=final)
        l0 = body("L0_ground")
        # L0 has no plan cells → no construct workset-fill (the "49 denied" bug),
        # and it does not enter construct mode.
        self.assertNotIn("workset slices", l0, "L0_ground must not workset-fill")
        self.assertNotIn("mc construct show", l0, "L0_ground must not enter construct fill")
        self.assertIn("ground_prep:", l0)
        # gv2-2026-06-25-1: L0 blocked at construct end (extra=49 natural grass vs the
        # zero-cell plan slice). --skip-gates skips only custom plan gates, not the
        # phase-clean check — a prep phase must skip BOTH or it can never close.
        self.assertIn("mc construct end --skip-gates --skip-phase-gate", l0,
                      "L0 prep-phase construct end must skip the phase-clean gate")
        # L1/L3/L4 fill their ACTUAL block (not a hardcoded cobblestone).
        # Plan GATE-MATERIAL: L3 walls oak_planks; L4 roof oak_planks (operator
        # 2026-06-25: planks for walls, not logs — faster/standard to build with).
        l1, l3, l4 = body("L1_slab"), body("L3_walls"), body("L4_roof", final=True)
        self.assertIn("mc fill cobblestone (workset", l1)
        self.assertIn("mc fill oak_planks (workset", l3)
        self.assertNotIn("mc fill cobblestone", l3, "L3 walls must fill oak_planks, not cobblestone")
        self.assertNotIn("mc fill oak_log", l3, "L3 walls are oak_planks now, not oak_log")
        self.assertIn("mc fill oak_planks (workset", l4)
        self.assertIn("--range 2..4", l3)
        self.assertIn("mc blueprint verify starter_shelter --range 2..4", l3)

    def test_verify_card_matches_construct_slice(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plan = patch_starter_shelter_plan(REPO, Path(tmp), {"x": 10, "y": 65, "z": 10})
        for phase_key in ("L1_slab", "L3_walls", "L4_roof"):
            ph = phase_record(plan, phase_key) or {}
            level, phase_range = ph.get("level"), ph.get("range")
            construct = _construct_body_for_phase(
                plan,
                phase_key,
                worksite=":shelter:",
                anchor_mark="base_anchor",
                checkout_near="base_anchor",
                final_phase=phase_key == "L4_roof",
            )
            if phase_range:
                verify_cli = f"mc blueprint verify starter_shelter --range {phase_range}"
            elif level is not None:
                verify_cli = f"mc blueprint verify starter_shelter --level {int(level)}"
            else:
                verify_cli = "mc blueprint verify starter_shelter --range 0..0"
            verify = verify_card_body(
                plan_id="starter_shelter",
                phase_key=phase_key,
                anchor_mark="base_anchor",
                checkout_near="base_anchor",
                verify_cli=verify_cli,
            )
            self.assertIn(verify_cli, construct, f"{phase_key} CONSTRUCT verify line")
            self.assertIn(verify_cli, verify, f"{phase_key} VERIFY verify_cmd")
            self.assertNotIn("--range 3..4", verify, "gv2-11 L3 slice drift")

    def test_l3_oak_planks_supply_not_mining_intent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plan = patch_starter_shelter_plan(REPO, Path(tmp), {"x": 10, "y": 65, "z": 10})
        cards = supply_cards_for_phase(plan, "L3_walls", destination="chest_stone")
        self.assertTrue(any("oak_planks" in c["title"] for c in cards))
        self.assertFalse(any("oak_log" in c["title"] for c in cards), "walls are planks now")
        for card in cards:
            val = validate_card(
                title=card["title"],
                body=card["body"],
                assignee="colony-gatherer",
            )
            self.assertTrue(val["ok"], val["errors"])

    def test_chest_on_top_of_slab_not_embedded(self) -> None:
        base = {"x": 53, "y": 65, "z": 49}
        body = shelter_chests_card_body(base)
        ax, ay, az = base["x"], base["y"], base["z"]
        ox, oy, oz = footprint_min_from_base_anchor(base)
        slab_y = oy + 1  # cobblestone floor plane (== ay)
        # gv2-2026-06-25-2 (operator obs): chests were placed AT the slab plane,
        # embedded in the cobblestone floor. They must sit ON TOP of the slab
        # (slab_y + 1), interior, supported by the cobblestone below.
        self.assertIn(f"mc place chest {ax - 1} {slab_y + 1} {az}", body)
        self.assertIn(f"mc place chest {ax - 1} {slab_y + 1} {az + 1}", body)
        # NOT embedded in the slab plane itself.
        self.assertNotIn(f"mc place chest {ax - 1} {slab_y} {az}", body)
        # Interior column, not the footprint perimeter (walls live at ox / ox+6).
        self.assertTrue(ox < ax - 1 < ox + 6, "chest must be an interior cell")


if __name__ == "__main__":
    unittest.main()
