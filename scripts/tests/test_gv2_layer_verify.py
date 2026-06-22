"""Tests for verify_layer — replays the gv2-2026-06-22-1 flood pattern.

The mock rcon_fn prepends a banner line (run_batch does this in production) so the
positional parser's last-N-lines logic is exercised.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from scripts.lib.gv2_layer_verify import classify_cells, verify_layer  # noqa: E402

_CMD = re.compile(r"positioned (-?\d+) (-?\d+) (-?\d+) if block ~ ~ ~ minecraft:(\w+)")


def make_rcon(world_blocks, *, banner=True):
    """world_blocks: {(x,y,z): material}. Missing cell => 'air'."""
    def rcon_fn(_world, cmds):
        out = ["[banner] batch start"] if banner else []
        for c in cmds:
            m = _CMD.search(c)
            x, y, z, mat = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4)
            actual = world_blocks.get((x, y, z), "air")
            out.append("Test passed" if actual == mat else "Test failed")
        return "\n".join(out)
    return rcon_fn


def test_classify_cells_handles_banner():
    w = {(0, 64, 0): "cobblestone", (1, 64, 0): "water"}
    cls = classify_cells("genesis2", 64, [(0, 0), (1, 0), (2, 0)], make_rcon(w))
    assert cls == {(0, 0): "cobblestone", (1, 0): "water", (2, 0): "air"}


def test_ground_gate_passes_when_solid_and_dry():
    # 3x3 footprint at origin corner, all cobblestone at L0 (y=63).
    blocks = {(x, 63, z): "cobblestone" for x in range(50, 53) for z in range(46, 49)}
    r = verify_layer(origin=(50, 63, 46), footprint=(3, 3), offset=0, gate="ground",
                     rcon_fn=make_rcon(blocks))
    assert r["ok"] is True and r["offenders"] == []


def test_ground_gate_fails_on_air_and_water_like_run7():
    # gv2-2026-06-22-1: L0 had air holes + water intrusion. Leave most cells air,
    # one water -> gate fails and lists offenders.
    blocks = {(50, 63, 46): "cobblestone", (51, 63, 46): "water"}  # rest default air
    r = verify_layer(origin=(50, 63, 46), footprint=(3, 3), offset=0, gate="ground",
                     rcon_fn=make_rcon(blocks))
    assert r["ok"] is False
    assert "air/water" in r["gate_failed"]
    founds = {o["found"] for o in r["offenders"]}
    assert "air" in founds and "water" in founds


def test_slab_gate_fails_on_natural_ground():
    # Natural dirt/grass must NOT count as slab (the -22-1 illusion).
    blocks = {(x, 64, z): "dirt" for x in range(50, 53) for z in range(46, 49)}
    r = verify_layer(origin=(50, 63, 46), footprint=(3, 3), offset=1, gate="slab",
                     rcon_fn=make_rcon(blocks))
    assert r["ok"] is False and "slab coverage" in r["gate_failed"]


def test_slab_gate_passes_when_built():
    blocks = {(x, 64, z): "cobblestone" for x in range(50, 53) for z in range(46, 49)}
    r = verify_layer(origin=(50, 63, 46), footprint=(3, 3), offset=1, gate="slab",
                     rcon_fn=make_rcon(blocks))
    assert r["ok"] is True


def test_fixtures_gate_fails_on_chest_over_air():
    # Replay -22-1: chest present at y=63 but the cell below (y=62) is AIR.
    blocks = {(56, 63, 49): "chest", (59, 63, 49): "chest", (59, 62, 49): "cobblestone"}
    fixtures = [(56, 49, "chest"), (59, 49, "chest")]
    r = verify_layer(origin=(53, 63, 49), footprint=(7, 7), offset=0, gate="fixtures",
                     rcon_fn=make_rcon(blocks), fixtures=fixtures)
    assert r["ok"] is False
    off = r["offenders"]
    # 56,49 chest is over air -> offender at y=62; 59,49 is on slab -> ok.
    assert any(o["x"] == 56 and o["expected"] == "slab-under-fixture" for o in off)
    assert not any(o["x"] == 59 for o in off)


def test_fixtures_gate_passes_when_on_slab():
    blocks = {(56, 63, 49): "chest", (56, 62, 49): "cobblestone"}
    r = verify_layer(origin=(53, 63, 49), footprint=(7, 7), offset=0, gate="fixtures",
                     rcon_fn=make_rcon(blocks), fixtures=[(56, 49, "chest")])
    assert r["ok"] is True


def test_fixtures_gate_fails_on_missing_fixture():
    blocks = {(56, 62, 49): "cobblestone"}  # nothing at 56,63,49 -> air
    r = verify_layer(origin=(53, 63, 49), footprint=(7, 7), offset=0, gate="fixtures",
                     rcon_fn=make_rcon(blocks), fixtures=[(56, 49, "chest")])
    assert r["ok"] is False
    assert any(o["expected"] == "chest" and o["found"] == "air" for o in r["offenders"])
