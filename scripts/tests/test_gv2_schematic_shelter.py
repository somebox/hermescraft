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

from scripts.lib.gv2_schematic_shelter import (  # noqa: E402
    file_starter_shelter_sequence,
    footprint_min_from_base_anchor,
    patch_starter_shelter_plan,
)


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
        from scripts.lib.gv2_schematic_shelter import _construct_body_for_phase, phase_record
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
        # L1/L3/L4 fill their ACTUAL block (not a hardcoded cobblestone).
        l1, l3, l4 = body("L1_slab"), body("L3_walls"), body("L4_roof", final=True)
        self.assertIn("mc fill cobblestone (workset", l1)
        self.assertIn("mc fill oak_log (workset", l3)
        self.assertNotIn("mc fill cobblestone", l3, "L3 walls must fill oak_log, not cobblestone")
        self.assertIn("mc fill oak_planks (workset", l4)


if __name__ == "__main__":
    unittest.main()
