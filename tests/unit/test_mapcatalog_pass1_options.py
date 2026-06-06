"""Unit tests for pass1 option defaults."""

from pathlib import Path

import pytest

from mapcatalog.pass1_options import cubiomes_configured, parse_pass1_options
from mapcatalog.server_config import ServerConfig


def _cfg(*, binary: str | None = "tools/cubiome_scan/proc_biome_scan") -> ServerConfig:
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
        cubiomes_binary=binary,
        cubiomes_mc_enum="MC_1_21",
    )


@pytest.mark.unit
def test_verify_live_defaults_on_when_cubiomes_binary_exists():
    root = Path(__file__).resolve().parents[2]
    binary = root / "tools/cubiome_scan/proc_biome_scan"
    if not binary.is_file():
        pytest.skip("cubiomes binary not built")
    cfg = _cfg(binary=str(binary))
    opts = parse_pass1_options({}, {"pass1": {}}, cfg)
    assert opts.verify_live is True


@pytest.mark.unit
def test_verify_live_explicit_false_overrides_default():
    root = Path(__file__).resolve().parents[2]
    binary = root / "tools/cubiome_scan/proc_biome_scan"
    if not binary.is_file():
        pytest.skip("cubiomes binary not built")
    cfg = _cfg(binary=str(binary))
    opts = parse_pass1_options({"pass1": {"verify_live": False}}, {}, cfg)
    assert opts.verify_live is False


@pytest.mark.unit
def test_verify_live_when_off_disables():
    cfg = _cfg()
    opts = parse_pass1_options({"pass1": {"verify_live_when": "off"}}, {}, cfg)
    assert opts.verify_live is False


@pytest.mark.unit
def test_cubiomes_configured_requires_existing_file():
    assert cubiomes_configured({"cubiomes": {"binary": "/no/such/file"}}, None) is False
