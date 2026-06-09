import json
from pathlib import Path

import pytest

from mapcatalog.gates import gate_label, parse_gate_item, parse_gate_line
from mapcatalog.load import load_requirements
from mapcatalog.lint import lint_requirements
from mapcatalog.models import BiomeFractionGate, OreHitsGate
from mapcatalog.placements import parse_placement_value, topological_sort_placements
from mapcatalog.probe import FakeRconClient, blocks_match_batch, count_block_hits, parse_scoreboard_count
from mapcatalog.result import fingerprint_payload, sha256_fingerprint
from mapcatalog.sampling import disc_grid_cells, gate_sample_cell_count
from mapcatalog.units import parse_fraction, parse_unit

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.unit
def test_parse_fraction_percent():
    assert parse_fraction("75%") == pytest.approx(0.75)
    assert parse_fraction("5%") == pytest.approx(0.05)


@pytest.mark.unit
def test_parse_gate_biome_and_ore():
    g = parse_gate_line("biome in [plains, forest] >= 75%")
    assert isinstance(g, BiomeFractionGate)
    assert g.min_fraction == pytest.approx(0.75)
    assert "minecraft:plains" in g.allow

    g2 = parse_gate_line("block iron_ore hits >= 3 in y -32..48 step 8")
    assert isinstance(g2, OreHitsGate)
    assert g2.min_hits == 3
    assert g2.y_range == (-32, 48)


@pytest.mark.unit
def test_parse_gate_structured():
    g = parse_gate_item({"gate": "surface_block", "block": "water", "max": "5%"})
    assert g.max_fraction == pytest.approx(0.05)


@pytest.mark.unit
def test_placement_topo_and_offset():
    spawn = parse_placement_value("spawn", "random_safe radius 1 attempts 32")
    muster = parse_placement_value("muster", "offset_from spawn [6, 0, 0]")
    end = parse_placement_value("return_post", "ground_offset_from overlook [0, 0, 48]")
    assert end.method == "ground_offset_from"
    assert end.offset == (0, 0, 48)
    order = topological_sort_placements([muster, spawn])
    assert [p.name for p in order] == ["spawn", "muster"]


@pytest.mark.unit
def test_placement_cycle_fails():
    a = parse_placement_value("a", "offset_from b [1,0,0]")
    b = parse_placement_value("b", "offset_from a [1,0,0]")
    with pytest.raises(ValueError, match="cycle"):
        topological_sort_placements([a, b])


@pytest.mark.unit
def test_load_mine_plains_iron_extends():
    req = load_requirements(ROOT / "requirements/mine_plains_iron.yaml")
    assert req.id == "mine_plains_iron"
    # Profile chain must surface multiple gates from profiles/plains_mining
    # (biome, distinct, flat, jitter, water, iron_ore, cave_air).
    assert len(req.gates) >= 7
    assert req.placements[-1].name == "iron_view"
    assert req.find.solutions == 5


@pytest.mark.unit
def test_load_harness_extends_chain():
    """Regression: harness → realism → profile must surface the profile's
    gates and placements through the full chain (not just one level)."""
    req = load_requirements(ROOT / "requirements/mine_plains_iron_harness.yaml")
    assert req.id == "mine_plains_iron_harness"
    assert len(req.gates) >= 7, (
        f"expected harness to inherit profile gates via 2-level chain; "
        f"got {len(req.gates)} (extends not recursive?)"
    )
    names = [p.name for p in req.placements]
    assert "spawn" in names and "muster" in names and "iron_view" in names


@pytest.mark.unit
def test_extends_cycle_detection(tmp_path):
    """Two files that extend each other should raise, not infinite-loop."""
    a = tmp_path / "a.yaml"
    b = tmp_path / "b.yaml"
    a.write_text("id: a\nextends: ./b\n")
    b.write_text("id: b\nextends: ./a\n")
    with pytest.raises((ValueError, RecursionError)):
        load_requirements(a)


@pytest.mark.unit
def test_lint_mine_plains_iron_ok():
    report = lint_requirements(ROOT / "requirements/mine_plains_iron.yaml")
    assert report.ok, report.errors


@pytest.mark.unit
def test_disc_sampling_count():
    from mapcatalog.models import Arena

    arena = Arena(center=(0, 0), radius=64)
    cells = disc_grid_cells(arena, 16)
    assert len(cells) > 0
    g = parse_gate_line("flat patch >= 16 cells")
    assert gate_sample_cell_count(g, arena) == len(cells)


@pytest.mark.unit
def test_probe_fake_rcon_batch():
    client = FakeRconClient(responses=["Test passed\nTest failed\n"])
    hits = blocks_match_batch(client, "proc-lab", [(0, 64, 0), (1, 64, 0)], "iron_ore")
    assert hits == [True, False]
    assert len(client.call_log) == 1


@pytest.mark.unit
def test_scoreboard_parse():
    assert parse_scoreboard_count("#probe has 3 [mapcatalog]") == 3


@pytest.mark.unit
def test_fingerprint_stable():
    payload = fingerprint_payload(
        "mine_plains_iron",
        "424242",
        "1.21.4",
        {"center": [0, 0], "radius": 64},
        {"spawn": [1, 2, 3], "muster": [4, 5, 6]},
        [],
    )
    a = sha256_fingerprint(payload)
    b = sha256_fingerprint(payload)
    assert a == b
    assert len(a) == 64


@pytest.mark.unit
def test_cli_lint_json(capsys):
    from mapcatalog.cli import main

    code = main(["lint", "-r", str(ROOT / "requirements/mine_plains_iron.yaml"), "--json"])
    assert code == 0
    data = json.loads(capsys.readouterr().out)
    assert data["ok"] is True
    assert data["requirements_id"] == "mine_plains_iron"
