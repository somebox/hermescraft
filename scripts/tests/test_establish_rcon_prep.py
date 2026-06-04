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


# ── mission branches (Phase B5) ───────────────────────────────────────


class MappingMissionBranchesTest(unittest.TestCase):
    """prep_commands + tp_worker_commands switch chest NBT, starter kit, and
    lighting based on the --mission flag. Default `explore` must stay byte-
    identical to the pre-Phase-B output; `mapping` adds signs / torches /
    coal + dusk lighting (time 13000, dayCycle true)."""

    def _card(self) -> dict:
        return {
            "spawn": [4, 96, 24],
            "muster": [4, 96, 24],
            "starter_chest": [5, 95, 24],
        }

    # ── prep_commands lighting ──

    def test_explore_default_keeps_day_lighting(self):
        cmds = erp.prep_commands(self._card())
        joined = "\n".join(cmds)
        self.assertIn("time set day", joined)
        self.assertIn("gamerule doDaylightCycle false", joined)
        self.assertNotIn("time set 13000", joined)

    def test_mapping_switches_to_dusk_with_cycle(self):
        cmds = erp.prep_commands(self._card(), mission="mapping")
        joined = "\n".join(cmds)
        self.assertIn("time set 13000", joined,
                      msg="mapping should set time to dusk (13000)")
        self.assertIn("gamerule doDaylightCycle true", joined,
                      msg="mapping should re-enable the daylight cycle so dusk progresses")
        self.assertNotIn("time set day", joined)

    # ── prep_commands chest NBT ──

    def test_explore_chest_keeps_basic_kit(self):
        cmds = erp.prep_commands(self._card())
        merge = next(c for c in cmds if "data merge" in c)
        # Explore chest: 3 iron tools + 4 bread, no signs/torches/coal.
        self.assertIn("iron_pickaxe", merge)
        self.assertIn("bread", merge)
        self.assertNotIn("oak_sign", merge)
        self.assertNotIn("torch", merge)
        self.assertNotIn("coal", merge)

    def test_mapping_chest_adds_signs_torches_coal(self):
        cmds = erp.prep_commands(self._card(), mission="mapping")
        merge = next(c for c in cmds if "data merge" in c)
        self.assertIn('id:"minecraft:oak_sign",Count:16b', merge,
                      msg="mapping chest should hold 16 oak_sign")
        self.assertIn('id:"minecraft:torch",Count:64b', merge,
                      msg="mapping chest should hold 64 torches")
        self.assertIn('id:"minecraft:coal",Count:32b', merge,
                      msg="mapping chest should hold 32 coal for torch crafting")
        # Bread bumped from 4 to 16 for the longer ranging budget.
        self.assertIn('id:"minecraft:bread",Count:16b', merge)

    # ── tp_worker_commands starter kit ──

    def test_explore_starter_kit_unchanged(self):
        cmds = erp.tp_worker_commands(self._card(), ["Flint"])
        # Joined view for substring assertions.
        joined = "\n".join(cmds)
        self.assertIn("minecraft:iron_pickaxe", joined)
        self.assertIn("minecraft:crafting_table", joined)
        # No signs/torches in explore worker starter kit.
        self.assertNotIn("minecraft:oak_sign", joined)
        self.assertNotIn("minecraft:torch", joined)

    def test_mapping_starter_kit_adds_4_signs_16_torches(self):
        cmds = erp.tp_worker_commands(self._card(), ["Flint"], mission="mapping")
        joined = "\n".join(cmds)
        self.assertIn("minecraft:oak_sign 4", joined,
                      msg="mapping starter kit should give 4 oak_sign")
        self.assertIn("minecraft:torch 16", joined,
                      msg="mapping starter kit should give 16 torches")


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


# ── check_surface_safe (phase-14 fix: refuse water/lava spawns) ────────


class _FakeRconClient:
    """Test double that returns canned "Test passed/failed" responses
    keyed on the (x,y,z,block_id) tuple in the `execute if block` cmd."""

    def __init__(self, matches=None):
        # matches: iterable of (x, y, z, block_id) — those return "Test passed",
        # everything else returns "Test failed".
        self.matches = set(matches or [])
        self.calls = []

    def run(self, cmd: str) -> str:
        self.calls.append(cmd)
        # Parse the trailing "<x> <y> <z> <block_id>" from
        # `execute in <world> if block <x> <y> <z> <block_id>`.
        parts = cmd.split()
        try:
            x, y, z = int(parts[-4]), int(parts[-3]), int(parts[-2])
            block_id = parts[-1]
        except (ValueError, IndexError):
            return "Test failed"
        if (x, y, z, block_id) in self.matches:
            return "Test passed"
        return "Test failed"


class CheckSurfaceSafeTest(unittest.TestCase):
    """Phase-14 (2026-06-03): the surface probe alone can't tell water
    from land — `find_surface_heights` stops at any non-air block. On
    seed-1001 islands the probe returned feet Y at the water surface;
    bots TP'd into the sea and drowned. The post-resolve safety check
    runs `execute if block` predicates against water + lava on the
    standing-on cell (sy-1) AND the feet cell (sy). Anything matching
    causes a descriptive string to be returned; clean land returns None."""

    def test_clean_land_returns_none(self):
        client = _FakeRconClient()  # no matches → all "Test failed"
        result = erp.check_surface_safe(
            client, world="proc-lab", sx=4, sy=80, sz=24,
        )
        self.assertIsNone(result)
        # Check we actually ran the right predicates: y-1 + y, water + lava.
        self.assertEqual(len(client.calls), 4)

    def test_water_on_standing_cell_is_reported(self):
        # Standing-on at y-1: water
        client = _FakeRconClient(matches={(4, 79, 24, "minecraft:water")})
        result = erp.check_surface_safe(
            client, world="proc-lab", sx=4, sy=80, sz=24,
        )
        self.assertIsNotNone(result)
        self.assertIn("water", result)
        self.assertIn("standing-on", result)
        self.assertIn("(4,79,24)", result)

    def test_water_on_feet_cell_is_reported(self):
        # Feet at y: water — the seed-1001 case where probe stopped at
        # the water surface.
        client = _FakeRconClient(matches={(4, 64, 24, "minecraft:water")})
        result = erp.check_surface_safe(
            client, world="proc-lab", sx=4, sy=64, sz=24,
        )
        self.assertIsNotNone(result)
        self.assertIn("water", result)
        self.assertIn("feet-cell", result)
        self.assertIn("(4,64,24)", result)

    def test_lava_is_also_caught(self):
        client = _FakeRconClient(matches={(0, 50, 0, "minecraft:lava")})
        result = erp.check_surface_safe(
            client, world="proc-lab", sx=0, sy=51, sz=0,
        )
        self.assertIsNotNone(result)
        self.assertIn("lava", result)

    def test_short_circuit_on_first_match(self):
        # Standing-on water + feet lava: first match wins (standing-on water).
        client = _FakeRconClient(matches={
            (4, 79, 24, "minecraft:water"),
            (4, 80, 24, "minecraft:lava"),
        })
        result = erp.check_surface_safe(
            client, world="proc-lab", sx=4, sy=80, sz=24,
        )
        self.assertIn("water", result)
        self.assertIn("standing-on", result)


# ── scan_neighborhood_safety (phase-15: 1-cell check missed an island) ──


def _land_heights_fn(land_y):
    """Stub `find_surface_heights` returning the same Y for every column."""

    def fn(client, world, columns, **_kwargs):
        return {(x, z): land_y for (x, z) in columns}

    return fn


def _mixed_heights_fn(water_cells, *, land_y, water_y=63):
    """Stub returning ``water_y`` for cells in ``water_cells``, else ``land_y``."""
    water_set = set(water_cells)

    def fn(client, world, columns, **_kwargs):
        return {
            (x, z): (water_y if (x, z) in water_set else land_y)
            for (x, z) in columns
        }

    return fn


def _none_heights_fn(none_cells, *, land_y):
    none_set = set(none_cells)

    def fn(client, world, columns, **_kwargs):
        return {
            (x, z): (None if (x, z) in none_set else land_y) for (x, z) in columns
        }

    return fn


class ScanNeighborhoodSafetyTest(unittest.TestCase):
    """Phase-15 (2026-06-03): the 1-cell ``check_surface_safe`` passed at
    Y=201 because a single tall stone column wasn't water — but the
    surrounding terrain was open ocean and bots fell 138 blocks. The
    neighborhood scan probes a (2*radius+1)² grid and classifies each
    column as land/water/lava/cliff/air."""

    def test_all_land_returns_100_pct(self):
        client = _FakeRconClient()  # everything Test failed → no water/lava
        scan = erp.scan_neighborhood_safety(
            client, world="proc-lab", sx=0, sy=80, sz=0, radius=2,
            heights_fn=_land_heights_fn(80),
        )
        self.assertEqual(scan["columns"], 25)
        self.assertEqual(scan["land"], 25)
        self.assertEqual(scan["water"], 0)
        self.assertEqual(scan["land_pct"], 100.0)

    def test_water_cells_classified(self):
        # 5 cells along the edge are water; rest land. Water is detected
        # at block_y = surface_y - 1, e.g. 79 here.
        water_cells = [(2, -2), (2, -1), (2, 0), (2, 1), (2, 2)]
        client = _FakeRconClient(matches={
            (x, 79, z, "minecraft:water") for (x, z) in water_cells
        })
        scan = erp.scan_neighborhood_safety(
            client, world="proc-lab", sx=0, sy=80, sz=0, radius=2,
            heights_fn=_land_heights_fn(80),
        )
        self.assertEqual(scan["water"], 5)
        self.assertEqual(scan["land"], 20)
        self.assertAlmostEqual(scan["land_pct"], 80.0)

    def test_cliff_cells_flagged_when_y_outside_window(self):
        # One cell sits 30 blocks below the centre — that's a cliff edge,
        # not a viable spawn neighbour.
        cliff_cells = [(2, 2)]
        client = _FakeRconClient()
        scan = erp.scan_neighborhood_safety(
            client, world="proc-lab", sx=0, sy=80, sz=0, radius=2,
            heights_fn=_mixed_heights_fn(cliff_cells, land_y=80, water_y=50),
        )
        self.assertEqual(scan["cliff"], 1)
        self.assertEqual(scan["land"], 24)
        self.assertEqual(scan["water"], 0)

    def test_air_columns_counted(self):
        # find_surface_heights returns None for OOB / unloaded columns.
        none_cells = [(-2, -2), (-2, -1), (-2, 0)]
        client = _FakeRconClient()
        scan = erp.scan_neighborhood_safety(
            client, world="proc-lab", sx=0, sy=80, sz=0, radius=2,
            heights_fn=_none_heights_fn(none_cells, land_y=80),
        )
        self.assertEqual(scan["air"], 3)
        self.assertEqual(scan["land"], 22)

    def test_phase_15_stone_column_in_ocean_is_rejected(self):
        # The phase-15 case: only the centre column is solid; all 24
        # neighbours are water at sea level.
        non_centre = [(x, z) for x in range(-2, 3) for z in range(-2, 3) if (x, z) != (0, 0)]
        client = _FakeRconClient(matches={
            (x, 62, z, "minecraft:water") for (x, z) in non_centre
        })
        scan = erp.scan_neighborhood_safety(
            client, world="proc-lab", sx=0, sy=201, sz=0, radius=2,
            heights_fn=_mixed_heights_fn(non_centre, land_y=201, water_y=63),
        )
        # Centre is land at Y=201; 24 neighbours have water_y=63 which
        # is >12 blocks below 201 → they're flagged as cliff first
        # (cliff classification short-circuits the water check). Either
        # way the patch is hostile and assert_neighborhood_land should
        # reject it.
        self.assertEqual(scan["land"], 1)
        self.assertEqual(scan["cliff"], 24)
        self.assertEqual(scan["land_pct"], 4.0)


class AssertNeighborhoodLandTest(unittest.TestCase):
    """The high-level gate ``assert_neighborhood_land`` returns None for
    safe sites and a one-line string for hostile ones."""

    def test_all_land_passes(self):
        client = _FakeRconClient()
        result = erp.assert_neighborhood_land(
            client, world="proc-lab", sx=0, sy=80, sz=0,
            radius=2, min_land_pct=80.0,
            heights_fn=_land_heights_fn(80),
        )
        self.assertIsNone(result)

    def test_at_threshold_passes(self):
        # Exactly 80% land → at threshold → passes.
        water_cells = [(2, z) for z in range(-2, 3)]  # 5 cells = 20%
        client = _FakeRconClient(matches={
            (x, 79, z, "minecraft:water") for (x, z) in water_cells
        })
        result = erp.assert_neighborhood_land(
            client, world="proc-lab", sx=0, sy=80, sz=0,
            radius=2, min_land_pct=80.0,
            heights_fn=_land_heights_fn(80),
        )
        self.assertIsNone(result)

    def test_below_threshold_fails_with_descriptive_string(self):
        # 6/25 = 24% water; 76% land < 80% threshold → reject.
        water_cells = [(2, z) for z in range(-2, 3)] + [(1, 2)]
        client = _FakeRconClient(matches={
            (x, 79, z, "minecraft:water") for (x, z) in water_cells
        })
        result = erp.assert_neighborhood_land(
            client, world="proc-lab", sx=0, sy=80, sz=0,
            radius=2, min_land_pct=80.0,
            heights_fn=_land_heights_fn(80),
        )
        self.assertIsNotNone(result)
        self.assertIn("water=6", result)
        self.assertIn("land=19", result)


if __name__ == "__main__":
    unittest.main()
