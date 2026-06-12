"""RCON sampling adapter — exercises sample_corridor + ingest_via_rcon
end-to-end against a FakeRconClient. The Phase-1 visibility-mask
rehearsal (sliding-window masked solve still converges to the expected
route class) is in test_roadplan_visibility_mask.py.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from roadplan.ledger import samples_for_solver  # noqa: E402
from roadplan.rcon_adapter import (  # noqa: E402
    ingest_via_rcon, sample_corridor,
)
from roadplan.spec import load_spec  # noqa: E402
from roadplan.torch_chain import place_chain  # noqa: E402

SPEC = load_spec()
WORLD = "test-world"


class FakeRcon:
    """Test double accepting both `run_batch` (mapcatalog.metrics calls
    this) and `run` (single-shot probes). Block matches keyed on
    (x, y, z, tag). Air predicate is `#minecraft:air` — match means the
    cell is empty; non-match means it's solid (the find_surface_heights
    convention).
    """

    def __init__(self, *, solids=None, water=None, lava=None, logs=None,
                 leaves=None, snow_layer=None, short_grass=None, torches=None):
        self.solids = set(solids or [])             # (x, y, z) is true solid
        self.water = set(water or [])               # (x, y, z) is water
        self.lava = set(lava or [])
        self.logs = set(logs or [])
        self.leaves = set(leaves or [])
        self.snow_layer = set(snow_layer or [])
        self.short_grass = set(short_grass or [])
        self.torches = set(torches or [])           # passable, matches torch tag
        self.batches = []
        self.cmd_count = 0

    # The set of "anything non-air at this cell" — find_surface_heights
    # uses #minecraft:air as its descent predicate, so leaves, logs, etc.
    # count as solid in that pass even though the walkable-descent pass
    # learns to skip them.
    @property
    def _nonair(self):
        return (self.solids | self.water | self.lava | self.logs
                | self.leaves | self.snow_layer | self.short_grass)

    def _classify(self, cmd):
        # `execute in <world> if block <x> <y> <z> <tag>`
        m = re.match(
            r"execute in \S+ if block (-?\d+) (-?\d+) (-?\d+) (\S+)$", cmd)
        if not m:
            return "Test failed"
        x, y, z, tag = int(m[1]), int(m[2]), int(m[3]), m[4]
        cell = (x, y, z)
        if tag == "#minecraft:air":
            return "Test passed" if cell not in self._nonair else "Test failed"
        if tag in ("minecraft:water", "minecraft:flowing_water"):
            return "Test passed" if cell in self.water else "Test failed"
        if tag in ("minecraft:lava", "minecraft:flowing_lava"):
            return "Test passed" if cell in self.lava else "Test failed"
        if tag == "#minecraft:logs":
            return "Test passed" if cell in self.logs else "Test failed"
        if tag == "#minecraft:leaves":
            return "Test passed" if cell in self.leaves else "Test failed"
        if tag == "minecraft:snow":
            # Match either snow blocks OR snow_layer fixture cells; the
            # Paper version doesn't distinguish snow_layer as a block ID.
            return "Test passed" if cell in self.snow_layer else "Test failed"
        if tag == "minecraft:short_grass":
            return "Test passed" if cell in self.short_grass else "Test failed"
        if tag == "minecraft:torch":
            return "Test passed" if cell in self.torches else "Test failed"
        # Other passable tags (#minecraft:saplings, tall_grass, fern, etc.)
        # never match in this harness — sufficient for the tests we have.
        return "Test failed"

    def run_batch(self, cmds):
        self.batches.append(list(cmds))
        self.cmd_count += len(cmds)
        return "\n".join(self._classify(c) for c in cmds)

    def run(self, cmd):
        self.cmd_count += 1
        return self._classify(cmd)


def _flat_solids(xs, zs, surface_y, depth=30):
    """A solid column from surface_y down `depth` blocks per (x, z) —
    the descent needs a floor to land on; we model bedrock-ish solid
    rather than a one-block plateau over air. (Earlier tests used a
    one- or two-block top because the old find_surface_heights based
    adapter stopped at the topmost non-air; the new descent walks past
    any single foliage block and needs something to actually stop on.)"""
    return {(x, surface_y - dy, z)
            for x in xs for z in zs for dy in range(depth + 1)}


def test_sample_corridor_all_ground():
    bounds = (-1, 0, 1, 4)
    solids = _flat_solids(range(-1, 2), range(0, 5), surface_y=63)
    client = FakeRcon(solids=solids)
    cells = sample_corridor(client, WORLD, bounds, y_hint=63, spec=SPEC)
    assert len(cells) == 3 * 5
    kinds = {(c["x"], c["z"]): c["kind"] for c in cells}
    assert all(k == "ground" for k in kinds.values()), kinds
    # Post-fix: y_step=1 fine pass + walkable descent → feet_y = surface_y + 1
    # exactly (the stand cell above the grass).
    ys = {c["y"] for c in cells if c["y"] is not None}
    assert ys == {64.0}, ys


def test_sample_corridor_water_and_tree_classified():
    bounds = (-1, 0, 1, 4)
    solids = _flat_solids(range(-1, 2), range(0, 5), surface_y=63)
    # Water/log probes target floor_y = feet_y - 1 = 63 (the surface block).
    client = FakeRcon(solids=solids,
                      water={(0, 63, 2)}, logs={(1, 63, 3)})
    cells = sample_corridor(client, WORLD, bounds, y_hint=63, spec=SPEC)
    by_xz = {(c["x"], c["z"]): c for c in cells}
    assert by_xz[(0, 2)]["kind"] == "water"
    assert by_xz[(1, 3)]["kind"] == "tree"
    assert by_xz[(-1, 0)]["kind"] == "ground"


def test_walkable_descent_skips_foliage_canopy():
    """A tree column (logs+leaves above dirt) must report feet_y at the
    dirt surface — not at the canopy. Kind is `tree` (the trunk above
    the feet IS a road-planning deficit), but the Y must be the ground."""
    bounds = (0, 0, 0, 0)
    # Tree column: dirt at 72, logs at 73-77, leaves at 78 + 76 + 75.
    client = FakeRcon(
        solids={(0, 72, 0)},
        logs={(0, 73, 0), (0, 74, 0), (0, 75, 0), (0, 76, 0), (0, 77, 0)},
        leaves={(0, 78, 0), (0, 76, 0), (0, 75, 0)},
    )
    cells = sample_corridor(client, WORLD, bounds, y_hint=73, spec=SPEC)
    assert cells[0]["kind"] == "tree", cells[0]
    # Feet land on top of the dirt at 72 → y=73, not at the leaves at 79.
    assert cells[0]["y"] == 73.0, cells[0]


def test_walkable_descent_pure_leaves_column_skips_to_ground():
    """A leaves-only canopy with no logs (decorative tree top): the
    descent must still skip the leaves and land on whatever solid is
    below, with kind=ground (no trunk → no tree deficit)."""
    bounds = (0, 0, 0, 0)
    client = FakeRcon(
        solids={(0, 65, 0)},
        leaves={(0, 70, 0), (0, 69, 0)},
    )
    cells = sample_corridor(client, WORLD, bounds, y_hint=66, spec=SPEC)
    assert cells[0]["kind"] == "ground", cells[0]
    assert cells[0]["y"] == 66.0, cells[0]


def test_walkable_descent_skips_snow_and_grass_tufts():
    """A common terrain shape: grass_block at y=63 with snow at 64 and
    short_grass at 65. The walkable surface is the grass_block; feet sit
    at y=64. (Pre-fix the snow was the reported surface.)"""
    bounds = (0, 0, 0, 0)
    solids = _flat_solids(range(0, 1), range(0, 1), surface_y=63)
    client = FakeRcon(
        solids=solids,
        snow_layer={(0, 64, 0)},     # FakeRcon treats this as `minecraft:snow`
        short_grass={(0, 65, 0)},
    )
    cells = sample_corridor(client, WORLD, bounds, y_hint=63, spec=SPEC)
    assert cells[0]["kind"] == "ground", cells[0]
    assert cells[0]["y"] == 64.0, cells[0]


def test_walkable_descent_odd_y_surface_is_not_off_by_one():
    """Parity regression: a solid surface at an odd Y (here 63) must
    report feet_y=64. Pre-fix, the y_step=2 fine pass skipped y=63 and
    recorded feet_y=63 — torches placed at that 'feet_y' landed *inside*
    the grass."""
    bounds = (0, 0, 0, 0)
    client = FakeRcon(solids={(0, 63, 0)})
    cells = sample_corridor(client, WORLD, bounds, y_hint=64, spec=SPEC)
    assert cells[0]["y"] == 64.0, cells[0]


def test_spike_repair_takes_floor_under_overhang():
    """A column carrying a solid shelf well above its neighbors (the
    61,-100 field case: roof at 102-110, true floor at 96) must report
    the floor under the shelf, not the roof top."""
    bounds = (-1, -1, 1, 1)
    solids = _flat_solids(range(-1, 2), range(-1, 2), surface_y=96)
    # Overhang on the center column only: solid 102..110.
    solids |= {(0, y, 0) for y in range(102, 111)}
    client = FakeRcon(solids=solids)
    cells = sample_corridor(client, WORLD, bounds, y_hint=97, spec=SPEC)
    by_xz = {(c["x"], c["z"]): c for c in cells}
    assert by_xz[(0, 0)]["y"] == 97.0, by_xz[(0, 0)]
    assert by_xz[(0, 0)]["kind"] == "ground"
    assert by_xz[(1, 1)]["y"] == 97.0


def test_spike_repair_keeps_genuine_solid_bump():
    """A real one-column pillar (solid all the way down) has no second
    surface below — the original feet must stand."""
    bounds = (-1, -1, 1, 1)
    solids = _flat_solids(range(-1, 2), range(-1, 2), surface_y=63)
    # Solid pillar on the center column up to y=72, attached to ground.
    solids |= {(0, y, 0) for y in range(64, 73)}
    client = FakeRcon(solids=solids)
    cells = sample_corridor(client, WORLD, bounds, y_hint=63, spec=SPEC)
    by_xz = {(c["x"], c["z"]): c for c in cells}
    assert by_xz[(0, 0)]["y"] == 73.0, by_xz[(0, 0)]
    assert by_xz[(-1, 1)]["y"] == 64.0


def test_sample_corridor_unloaded_or_no_floor_is_gap():
    # No solids anywhere → every column reports surface_y=None → kind=gap.
    client = FakeRcon(solids=set())
    cells = sample_corridor(client, WORLD, (0, 0, 0, 2), y_hint=63, spec=SPEC)
    assert all(c["kind"] == "gap" for c in cells)
    assert all(c["y"] is None for c in cells)


def test_sample_corridor_deep_floor_classified_as_gap():
    """A surface much further below the line elevation than
    `no_floor_min_depth` becomes a gap. The descent still reports a
    feet_y so downstream bridging economics can use the deficit depth."""
    # Surface at y=40 with ref_height = y_hint+1 = 64.
    # 64 - 40 = 24 >= no_floor_min_depth (16) → gap.
    solids = _flat_solids(range(0, 1), range(0, 1), surface_y=40, depth=8)
    client = FakeRcon(solids=solids)
    spec = dict(SPEC)
    # Push the descent floor low enough to catch the y=40 surface
    spec["rcon_y_lo"] = 30
    cells = sample_corridor(client, WORLD, (0, 0, 0, 0), y_hint=63, spec=spec)
    assert cells[0]["kind"] == "gap"
    assert cells[0]["y"] == 41.0, cells[0]  # feet sit above the y=40 floor


def test_probe_budget_two_phase_scan():
    """The two-phase scan (coarse air grid + bracket + full-predicate
    refinement) must answer a flat 3x5 corridor in far fewer probes than
    the old exhaustive per-Y full-predicate descent (~6900 commands for
    this fixture). Guard against regressions back to per-Y probing."""
    bounds = (-1, 0, 1, 4)
    solids = _flat_solids(range(-1, 2), range(0, 5), surface_y=63)
    client = FakeRcon(solids=solids)
    cells = sample_corridor(client, WORLD, bounds, y_hint=63, spec=SPEC)
    assert all(c["y"] == 64.0 for c in cells), cells
    assert client.cmd_count < 1000, client.cmd_count


def _setblocks(client):
    return [c for b in client.batches for c in b if "setblock" in c]


def test_place_chain_natural_ground_places_torch_only():
    solids = _flat_solids(range(-2, 3), range(-2, 3), surface_y=63)
    client = FakeRcon(solids=solids)
    reports = place_chain(client, WORLD, [(0, 64, 0)])
    assert reports == [{"node": [0, 64, 0], "at": [0, 64, 0],
                        "status": "placed"}]
    sets = _setblocks(client)
    assert sets == [
        "execute in test-world run setblock 0 64 0 minecraft:torch"]


def test_place_chain_pit_snaps_to_lateral_grade():
    """A 1-wide pit under the waypoint: no natural anchor at deck
    elevation in-column — the torch goes one cell aside at grade, with
    no base block fabricated."""
    solids = _flat_solids(range(-2, 3), range(-2, 3), surface_y=63)
    solids -= {(0, y, 0) for y in range(58, 64)}    # pit floor at 57
    client = FakeRcon(solids=solids)
    reports = place_chain(client, WORLD, [(0, 64, 0)])
    assert reports[0]["status"] == "placed"
    ax, ay, az = reports[0]["at"]
    assert (ax, az) != (0, 0) and ay == 64, reports[0]
    sets = _setblocks(client)
    assert len(sets) == 1 and "minecraft:torch" in sets[0]


def test_place_chain_wide_pit_reports_needs_construction():
    solids = _flat_solids(range(-3, 4), range(-3, 4), surface_y=63)
    solids -= {(x, y, z) for x in range(-1, 2) for z in range(-1, 2)
               for y in range(50, 64)}
    client = FakeRcon(solids=solids)
    reports = place_chain(client, WORLD, [(0, 64, 0)])
    assert reports == [{"node": [0, 64, 0], "at": None,
                        "status": "needs_construction"}]
    assert _setblocks(client) == []


def test_place_chain_already_lit_is_untouched():
    solids = _flat_solids(range(-2, 3), range(-2, 3), surface_y=63)
    client = FakeRcon(solids=solids, torches={(0, 64, 0)})
    reports = place_chain(client, WORLD, [(0, 64, 0)])
    assert reports[0]["status"] == "already_lit"
    assert _setblocks(client) == []


def test_ingest_via_rcon_appends_ledger_and_round_trips(tmp_path):
    bounds = (-1, 0, 1, 4)
    solids = _flat_solids(range(-1, 2), range(0, 5), surface_y=63)
    # River + tree: water sits at the surface cell, log trunk over the
    # neighboring column.
    client = FakeRcon(solids=solids,
                      water={(0, 63, 2)}, logs={(1, 64, 3)})
    n, samples = ingest_via_rcon(client, WORLD, bounds, 63, tmp_path)
    assert n == 15
    assert len(samples) == 15
    # The ledger round-trip: samples_for_solver must reproduce the kinds
    # we just ingested (block_tag → kind mapping in ledger.py).
    round_tripped = {(s["x"], s["z"]): s["kind"]
                     for s in samples_for_solver(tmp_path)}
    expected = {(s["x"], s["z"]): s["kind"] for s in samples}
    assert round_tripped == expected
