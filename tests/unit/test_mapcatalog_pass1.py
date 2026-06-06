from unittest.mock import patch

import pytest

from mapcatalog.models import Arena
from mapcatalog.pass1 import BiomeScan, evaluate_pass1
from mapcatalog.server_config import ServerConfig


def _cfg() -> ServerConfig:
    return ServerConfig(
        minecraft_version="1.21.4",
        ssh_host="h",
        container="c",
        cli="rcon-cli",
        world_name="proc-lab",
        generator="NORMAL",
        hub_world="landfolk-test",
        hub_xyz=(0, 65, 0),
        use_unsafe_mvtp=True,
        cubiomes_binary="tools/cubiome_scan/proc_biome_scan",
        cubiomes_mc_enum="MC_1_21",
    )


@pytest.mark.unit
def test_pass1_rejects_low_biome_fraction():
    from mapcatalog.load import load_requirements
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    req = load_requirements(root / "requirements/mine_plains_iron.yaml")
    scan = BiomeScan(
        mc="MC_1_21",
        seed="1",
        cell_count=4,
        cells=[
            {"x": 0, "z": 0, "biome": "ocean"},
            {"x": 16, "z": 0, "biome": "ocean"},
            {"x": 0, "z": 16, "biome": "desert"},
            {"x": 16, "z": 16, "biome": "desert"},
        ],
    )
    with patch("mapcatalog.pass1.run_biome_scan", return_value=scan):
        out = evaluate_pass1(req, _cfg(), "1")
    assert not out.continue_pass2
    assert any("biome in" in r or "biome fraction" in r for r in out.reasons)


@pytest.mark.unit
def test_pass1_accepts_plains_heavy_scan():
    from mapcatalog.load import load_requirements
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    req = load_requirements(root / "requirements/mine_plains_iron.yaml")
    cells = [{"x": i, "z": 0, "biome": "plains"} for i in range(0, 64, 16)]
    scan = BiomeScan(mc="MC_1_21", seed="1", cell_count=len(cells), cells=cells)
    with patch("mapcatalog.pass1.run_biome_scan", return_value=scan):
        out = evaluate_pass1(req, _cfg(), "1")
    assert out.continue_pass2
    assert out.audit.get("rejected") is False
