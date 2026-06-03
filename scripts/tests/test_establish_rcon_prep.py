"""Run-7 Step 4 (PR-H) — pure-function tests for establish-rcon-prep.

The rcon transport itself (`probe_surface_y` calling SshDockerRcon) is
operator-tested only; this bench locks in the spawn-Y resolution policy
+ prep_commands override behaviour so future refactors don't reintroduce
the run-7 floating-slab regression.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load_prep():
    loader = SourceFileLoader(
        "establish_rcon_prep",
        str(REPO / "scripts" / "establish-rcon-prep.py"),
    )
    spec = importlib.util.spec_from_loader("establish_rcon_prep", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["establish_rcon_prep"] = mod
    loader.exec_module(mod)
    return mod


erp = _load_prep()


# ── resolve_spawn_y ────────────────────────────────────────────────────


class ResolveSpawnYTest(unittest.TestCase):
    """Policy: catalog wins within tolerance; probe wins beyond it;
    probe-None fails closed (strict) or falls back to catalog (lenient)."""

    def test_within_tolerance_uses_catalog(self):
        # |96 - 95| = 1 ≤ 2 → catalog stays.
        self.assertEqual(erp.resolve_spawn_y(96, 95), 96)

    def test_at_tolerance_uses_catalog(self):
        # |96 - 94| = 2 ≤ 2 → catalog stays.
        self.assertEqual(erp.resolve_spawn_y(96, 94), 96)

    def test_above_tolerance_uses_probed(self):
        # |96 - 66| = 30 > 2 → probe wins. The run-7 regression scenario:
        # catalog says 96 (stale from prior reused world), probe finds
        # natural surface at 66 (fresh seed=1001 disc).
        self.assertEqual(erp.resolve_spawn_y(96, 66), 66)

    def test_probe_higher_than_catalog(self):
        # Catalog may also be too LOW (less common) — probe still wins.
        self.assertEqual(erp.resolve_spawn_y(64, 96), 96)

    def test_probe_none_strict_fails_closed(self):
        with self.assertRaises(SystemExit) as cm:
            erp.resolve_spawn_y(96, None, strict=True)
        msg = str(cm.exception)
        self.assertIn("probe failed", msg)
        self.assertIn("floating-slab", msg)

    def test_probe_none_lenient_falls_back_to_catalog(self):
        # --dry-run path uses lenient mode so it can print expected
        # commands without hitting rcon.
        self.assertEqual(erp.resolve_spawn_y(96, None, strict=False), 96)

    def test_custom_tolerance(self):
        # |96 - 90| = 6. With tolerance=10, catalog stays; with default 2, probe wins.
        self.assertEqual(erp.resolve_spawn_y(96, 90, tolerance=10), 96)
        self.assertEqual(erp.resolve_spawn_y(96, 90), 90)


# ── prep_commands with spawn_y_override ────────────────────────────────


class PrepCommandsOverrideTest(unittest.TestCase):
    """prep_commands honours spawn_y_override and produces /fill at the
    resolved Y, not the catalog Y. This is what closes the floating-slab
    regression end-to-end."""

    def _card(self, sy: int = 96) -> dict:
        return {
            "spawn": [4, sy, 24],
            "starter_chest": [5, 95, 24],
        }

    def test_no_override_uses_catalog_y(self):
        cmds = erp.prep_commands(self._card(sy=96))
        fills = [c for c in cmds if "fill" in c]
        self.assertGreaterEqual(len(fills), 2)
        # Air-clear fill includes the catalog Y in the lower bound.
        self.assertTrue(any("96" in c for c in fills),
                        msg=f"expected fill to use catalog Y=96; got {fills}")

    def test_override_replaces_catalog_y(self):
        cmds = erp.prep_commands(self._card(sy=96), spawn_y_override=66)
        fills = [c for c in cmds if "fill" in c]
        # The air-clear fill should reference 66, not 96.
        self.assertTrue(any("66" in c for c in fills),
                        msg=f"expected fill to use probed Y=66; got {fills}")
        # The setworldspawn should also use the resolved Y so the bot
        # spawns on the grass floor.
        spawn_cmd = next(c for c in cmds if "setworldspawn" in c)
        self.assertIn("4 66 24", spawn_cmd,
                      msg=f"setworldspawn must use resolved Y; got {spawn_cmd}")

    def test_chest_shifts_by_same_delta_as_spawn(self):
        # Run-8 evidence: the first cut of pr-h-surface-probe preserved
        # catalog chest_y while resolved spawn_y shifted by 17 — chest
        # ended up floating 16 blocks above the new grass floor. The
        # catalog's chest_y = spawn_y - 1 relationship MUST carry over.
        # Spawn 96 → 66 = delta -30. Chest 95 → 65 (preserving the -1
        # offset from spawn).
        cmds = erp.prep_commands(self._card(sy=96), spawn_y_override=66)
        chest_setblock = next(c for c in cmds if "setblock" in c and "chest" in c)
        self.assertIn("5 65 24", chest_setblock,
                      msg=f"chest should shift with spawn (delta -30); got {chest_setblock}")
        # data merge block must also point at the resolved chest coord.
        data_merge = next(c for c in cmds if "data merge block" in c)
        self.assertIn("5 65 24", data_merge,
                      msg=f"data merge must reference resolved chest coord; got {data_merge}")

    def test_chest_chest_y_minus_one_relation_preserved(self):
        # Legacy catalog convention: chest_y = spawn_y - 1. Any
        # spawn_y_override must preserve that delta even after the
        # establish-scenario.sh patch changed the live convention to
        # chest_y = spawn_y — the delta-shifter must remain
        # convention-agnostic so a stale or alternate catalog still
        # produces a coherent chest placement.
        for catalog_sy, override_sy in [(96, 79), (96, 64), (64, 96)]:
            card = {
                "spawn": [4, catalog_sy, 24],
                "starter_chest": [5, catalog_sy - 1, 24],
            }
            cmds = erp.prep_commands(card, spawn_y_override=override_sy)
            expected_chest_y = override_sy - 1
            chest_cmd = next(c for c in cmds if "setblock" in c and "chest" in c)
            self.assertIn(f"5 {expected_chest_y} 24", chest_cmd,
                msg=f"catalog_sy={catalog_sy} override={override_sy}: "
                    f"chest should be at Y={expected_chest_y}; got {chest_cmd}")

    def test_chest_at_spawn_level_convention_preserved(self):
        # Post-patch convention from establish-scenario.sh: chest_y =
        # spawn_y (chest BLOCK sits on the grass with its top sticking
        # up one block — a normal placed chest). The delta-shifter must
        # preserve this end-to-end so the override lands the chest at
        # exactly resolved_sy (no off-by-one drift).
        for catalog_sy, override_sy in [(96, 79), (96, 64), (64, 96)]:
            card = {
                "spawn": [4, catalog_sy, 24],
                "starter_chest": [5, catalog_sy, 24],  # chest at spawn-feet level
            }
            cmds = erp.prep_commands(card, spawn_y_override=override_sy)
            chest_cmd = next(c for c in cmds if "setblock" in c and "chest" in c)
            self.assertIn(f"5 {override_sy} 24", chest_cmd,
                msg=f"new convention (chest_y=spawn_y): catalog_sy={catalog_sy} "
                    f"override={override_sy}: chest should be at Y={override_sy}; "
                    f"got {chest_cmd}")

    def test_run7_regression_scenario(self):
        # Run-7: catalog Y=96 (stale), natural surface ~Y66, slab at 96.
        # With the override = 66, the air-clear should be at Y=66..69
        # (3 air layers above the grass) and the grass floor at Y=65.
        cmds = erp.prep_commands(self._card(sy=96), spawn_y_override=66)
        air = next(c for c in cmds if "air replace" in c)
        grass = next(c for c in cmds if "grass_block" in c)
        # Air fill bounds: sy to sy+3 = 66 to 69.
        self.assertIn(" 66 ", air, msg=f"air fill should include Y=66; got {air}")
        self.assertIn(" 69 ", air, msg=f"air fill should include Y=69; got {air}")
        # Grass floor: sy-1 = 65.
        self.assertIn(" 65 ", grass, msg=f"grass floor should include Y=65; got {grass}")


# ── apply_spawn_y_override (map JSON patch) ───────────────────────────


class ApplySpawnYOverrideTest(unittest.TestCase):
    """When the surface probe substitutes spawn Y, the map JSON on disk
    must be patched so seed-cards / tp_workers / bash all see the same
    coords. Run-8 evidence: probe shifted spawn 96→79 but kanban cards
    still encoded muster (4,96,24); workers fell 17 blocks on TP."""

    def _card(self, sy: int = 96) -> dict:
        return {
            "placements": {
                "spawn": [4, sy, 24],
                "muster": [4, sy, 24],
                "starter_chest": [5, sy - 1, 24],
            },
            "spawn": [4, sy, 24],
            "muster": [4, sy, 24],
            "starter_chest": [5, sy - 1, 24],
        }

    def test_spawn_y_patched_both_shapes(self):
        card = self._card(sy=96)
        erp.apply_spawn_y_override(card, 79)
        self.assertEqual(card["spawn"], [4, 79, 24])
        self.assertEqual(card["placements"]["spawn"], [4, 79, 24])

    def test_muster_re_collapsed_to_resolved_spawn(self):
        card = self._card(sy=96)
        erp.apply_spawn_y_override(card, 79)
        self.assertEqual(card["muster"], [4, 79, 24])
        self.assertEqual(card["placements"]["muster"], [4, 79, 24])

    def test_chest_shifts_by_same_delta(self):
        # Catalog chest at Y=95 (spawn 96 − 1); override to 79 → chest 78.
        card = self._card(sy=96)
        erp.apply_spawn_y_override(card, 79)
        self.assertEqual(card["starter_chest"], [5, 78, 24])
        self.assertEqual(card["placements"]["starter_chest"], [5, 78, 24])

    def test_chest_minus_one_relation_preserved(self):
        for catalog_sy, resolved_sy in [(96, 79), (96, 64), (64, 96)]:
            card = self._card(sy=catalog_sy)
            erp.apply_spawn_y_override(card, resolved_sy)
            self.assertEqual(card["starter_chest"][1], resolved_sy - 1,
                msg=f"catalog={catalog_sy} resolved={resolved_sy}: "
                    f"chest_y should be {resolved_sy-1}; "
                    f"got {card['starter_chest'][1]}")

    def test_x_z_coords_untouched(self):
        card = self._card(sy=96)
        erp.apply_spawn_y_override(card, 79)
        # The probe is column-local — X/Z must not move.
        self.assertEqual(card["spawn"][0], 4)
        self.assertEqual(card["spawn"][2], 24)
        self.assertEqual(card["starter_chest"][0], 5)
        self.assertEqual(card["starter_chest"][2], 24)

    def test_roundtrip_via_json(self):
        # Simulates the full file-write/read path that establish-scenario.sh
        # uses between rcon-prep --mode world and seed-cards.
        card = self._card(sy=96)
        erp.apply_spawn_y_override(card, 79)
        with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
            json.dump(card, f, indent=2)
            path = Path(f.name)
        try:
            roundtrip = json.loads(path.read_text())
            # _triple reads top-level first, falls back to placements —
            # both shapes must be coherent.
            sx, sy, sz = erp._triple(roundtrip, "spawn")
            mx, my, mz = erp._triple(roundtrip, "muster")
            cx, cy, cz = erp._triple(roundtrip, "starter_chest")
            self.assertEqual((sx, sy, sz), (4, 79, 24))
            self.assertEqual((mx, my, mz), (4, 79, 24))
            self.assertEqual((cx, cy, cz), (5, 78, 24))
        finally:
            path.unlink()


# ── _read_rcon_config (fallback path) ──────────────────────────────────


class ReadRconConfigTest(unittest.TestCase):
    """The script accepts a server.local.yaml path; missing/malformed
    yaml falls back to the agent-test.py hardcoded values."""

    def test_missing_file_returns_defaults(self):
        ssh, con = erp._read_rcon_config(Path("/nonexistent/server.yaml"))
        self.assertEqual(ssh, "ubuntu-host")
        self.assertEqual(con, "minecraft")

    def test_yaml_with_rcon_overrides_defaults(self):
        with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
            f.write("rcon:\n  ssh_host: example.host\n  container: mc-test\n")
            path = Path(f.name)
        try:
            ssh, con = erp._read_rcon_config(path)
            self.assertEqual(ssh, "example.host")
            self.assertEqual(con, "mc-test")
        finally:
            path.unlink()


if __name__ == "__main__":
    unittest.main()
