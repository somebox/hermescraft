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

SPEC = load_spec()
WORLD = "test-world"


class FakeRcon:
    """Test double accepting both `run_batch` (mapcatalog.metrics calls
    this) and `run` (single-shot probes). Block matches keyed on
    (x, y, z, tag). Air predicate is `#minecraft:air` — match means the
    cell is empty; non-match means it's solid (the find_surface_heights
    convention).
    """

    def __init__(self, *, solids=None, water=None, lava=None, logs=None):
        self.solids = set(solids or [])             # (x, y, z) is solid
        self.water = set(water or [])               # (x, y, z) is water
        self.lava = set(lava or [])                 # (x, y, z) is lava
        self.logs = set(logs or [])                 # (x, y, z) is a log
        self.batches = []
        self.cmd_count = 0

    def _classify(self, cmd):
        # `execute in <world> if block <x> <y> <z> <tag>`
        m = re.match(
            r"execute in \S+ if block (-?\d+) (-?\d+) (-?\d+) (\S+)$", cmd)
        if not m:
            return "Test failed"
        x, y, z, tag = int(m[1]), int(m[2]), int(m[3]), m[4]
        cell = (x, y, z)
        if tag == "#minecraft:air":
            return "Test passed" if cell not in self.solids else "Test failed"
        if tag == "minecraft:water":
            return "Test passed" if cell in self.water else "Test failed"
        if tag == "minecraft:lava":
            return "Test passed" if cell in self.lava else "Test failed"
        if tag == "#minecraft:logs":
            return "Test passed" if cell in self.logs else "Test failed"
        return "Test failed"

    def run_batch(self, cmds):
        self.batches.append(list(cmds))
        self.cmd_count += len(cmds)
        return "\n".join(self._classify(c) for c in cmds)

    def run(self, cmd):
        self.cmd_count += 1
        return self._classify(cmd)


def _flat_solids(xs, zs, surface_y):
    """Solid blocks at surface_y and surface_y-1 per column.

    find_surface_heights does a coarse scan (y_step=16) then refines with
    y_step=2 — so a thin one-block surface can be skipped if the fine
    step lands on the wrong parity. Two-block-thick floor mirrors
    real terrain (grass + dirt) and is robust to that quirk."""
    out = set()
    for x in xs:
        for z in zs:
            out.add((x, surface_y, z))
            out.add((x, surface_y - 1, z))
    return out


def test_sample_corridor_all_ground():
    bounds = (-1, 0, 1, 4)
    solids = _flat_solids(range(-1, 2), range(0, 5), surface_y=63)
    client = FakeRcon(solids=solids)
    cells = sample_corridor(client, WORLD, bounds, y_hint=63, spec=SPEC)
    assert len(cells) == 3 * 5
    kinds = {(c["x"], c["z"]): c["kind"] for c in cells}
    assert all(k == "ground" for k in kinds.values()), kinds
    # find_surface_heights returns the feet-Y its descending scan reports
    # (subject to upstream y_step parity); every cell on the same flat
    # plateau must agree on whatever that number is.
    ys = {c["y"] for c in cells if c["y"] is not None}
    assert len(ys) == 1, ys


def test_sample_corridor_water_and_tree_classified():
    bounds = (-1, 0, 1, 4)
    solids = _flat_solids(range(-1, 2), range(0, 5), surface_y=63)
    # Water/log probes target floor_y = feet_y - 1. find_surface_heights
    # on the model above returns feet_y = 63 (parity quirk), so floor_y = 62.
    client = FakeRcon(solids=solids,
                      water={(0, 62, 2)}, logs={(1, 62, 3)})
    cells = sample_corridor(client, WORLD, bounds, y_hint=63, spec=SPEC)
    by_xz = {(c["x"], c["z"]): c for c in cells}
    assert by_xz[(0, 2)]["kind"] == "water"
    assert by_xz[(1, 3)]["kind"] == "tree"
    assert by_xz[(-1, 0)]["kind"] == "ground"


def test_sample_corridor_unloaded_or_no_floor_is_gap():
    # No solids anywhere → every column reports surface_y=None → kind=gap.
    client = FakeRcon(solids=set())
    cells = sample_corridor(client, WORLD, (0, 0, 0, 2), y_hint=63, spec=SPEC)
    assert all(c["kind"] == "gap" for c in cells)
    assert all(c["y"] is None for c in cells)


def test_sample_corridor_deep_floor_classified_as_gap(monkeypatch):
    # find_surface_heights' default y_lo=48 caps how deep the live scan
    # looks — anything below registers as None, which our adapter
    # already maps to gap (test above). The "deep but found" branch is
    # exercised by stubbing the heightmap directly so we don't fight
    # the upstream scan window in fixture data.
    from roadplan import rcon_adapter
    monkeypatch.setattr(
        "mapcatalog.metrics.find_surface_heights",
        lambda client, world, columns: {c: 30 for c in columns},
    )
    client = FakeRcon()
    cells = sample_corridor(client, WORLD, (0, 0, 0, 0), y_hint=63, spec=SPEC)
    assert cells[0]["kind"] == "gap"
    # We DO still report the y so a future "would-bridging-help?" check
    # can decide span economics against the deficit.
    assert cells[0]["y"] is not None


def test_ingest_via_rcon_appends_ledger_and_round_trips(tmp_path):
    bounds = (-1, 0, 1, 4)
    solids = _flat_solids(range(-1, 2), range(0, 5), surface_y=63)
    client = FakeRcon(solids=solids,
                      water={(0, 63, 2)}, logs={(1, 63, 3)})
    n, samples = ingest_via_rcon(client, WORLD, bounds, 63, tmp_path)
    assert n == 15
    assert len(samples) == 15
    # The ledger round-trip: samples_for_solver must reproduce the kinds
    # we just ingested (block_tag → kind mapping in ledger.py).
    round_tripped = {(s["x"], s["z"]): s["kind"]
                     for s in samples_for_solver(tmp_path)}
    expected = {(s["x"], s["z"]): s["kind"] for s in samples}
    assert round_tripped == expected
