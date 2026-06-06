import pytest

from mapcatalog.metrics import find_surface_heights
from mapcatalog.probe import classify_air_probe_line


@pytest.mark.unit
def test_classify_air_probe_oob():
    assert classify_air_probe_line("That position is out of this world!") == "oob"


@pytest.mark.unit
def test_classify_air_probe_solid_and_air():
    assert classify_air_probe_line("Test passed") == "air"
    assert classify_air_probe_line("Test failed") == "solid"


@pytest.mark.unit
def test_find_surface_heights_skips_oob_layer():
    class BatchRcon:
        def run_batch(self, cmds: list[str]) -> str:
            lines = []
            for cmd in cmds:
                if " 320 " in cmd:
                    lines.append("That position is out of this world!")
                elif " 118 " in cmd:
                    lines.append("Test failed")
                else:
                    lines.append("Test passed")
            return "\n".join(lines)

    client = BatchRcon()
    h = find_surface_heights(client, "proc-lab", [(0, 0)], y_hi=320, y_lo=100, y_step=1)
    assert h[(0, 0)] == 119
