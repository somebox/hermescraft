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

    def test_chest_coords_preserved_under_override(self):
        # Catalog chest at (5, 95, 24) stays put — only spawn Y shifts.
        # (If we re-derived chest Y from the override, the chest would
        # land below the grass floor.)
        cmds = erp.prep_commands(self._card(sy=96), spawn_y_override=66)
        chest_cmd = next(c for c in cmds if "setblock" in c and "chest" in c)
        self.assertIn("5 95 24", chest_cmd,
                      msg=f"chest coord must use catalog (5,95,24); got {chest_cmd}")

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
