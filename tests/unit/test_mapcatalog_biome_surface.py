from unittest.mock import patch

import pytest

from mapcatalog.metrics import ColumnSample, probe_biome_fraction_at_surface
from mapcatalog.probe import FakeRconClient


@pytest.mark.unit
def test_biome_probe_uses_per_column_surface_y():
    client = FakeRconClient()
    cols = [
        ColumnSample(x=0, z=0, surface_y=90),
        ColumnSample(x=16, z=0, surface_y=118),
    ]
    y_seen: list[int] = []

    def fake_probe(_client, _world, x, y, z, bid):
        y_seen.append(y)
        return x == 0 and y == 89 and bid.endswith("plains")

    with patch("mapcatalog.metrics.probe_biome_cell", side_effect=fake_probe):
        frac, seen, _ = probe_biome_fraction_at_surface(
            client,
            "proc-lab",
            cols,
            ["minecraft:plains", "minecraft:forest"],
        )
    assert 89 in y_seen and 117 in y_seen
    assert frac == pytest.approx(0.5)
    assert "minecraft:plains" in seen
