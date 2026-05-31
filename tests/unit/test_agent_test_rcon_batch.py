"""Batched rcon block probes used by agent-test predicates."""
import importlib.util
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("agent_test_mod", ROOT / "scripts" / "agent-test.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def test_line_indicates_block_match():
    assert mod._line_indicates_block_match("Test passed")
    assert mod._line_indicates_block_match("The block matches")
    assert not mod._line_indicates_block_match("Test failed")
    assert not mod._line_indicates_block_match("")


def test_rcon_blocks_match_batch_maps_lines_to_cells():
    cells = [(1, 2, 3), (4, 5, 6)]
    fake_out = "Test passed\nTest failed\n"

    with patch.object(mod, "run_rcon_batch", return_value=fake_out) as batch:
        hits = mod._rcon_blocks_match_batch(cells, "cobblestone")

    assert hits == [True, False]
    batch.assert_called_once()
    sent = batch.call_args[0][0]
    assert len(sent) == 2
    assert "1 2 3" in sent[0]
    assert "4 5 6" in sent[1]


def test_count_block_in_bbox_sums_batch_hits():
    bb = {"x1": 0, "y1": 0, "z1": 0, "x2": 1, "y2": 0, "z2": 0}  # two cells
    with patch.object(mod, "_rcon_blocks_match_batch", return_value=[True, False]):
        assert mod._count_block_in_bbox("dirt", bb) == 1


def test_player_reset_includes_inventory_clear():
    cmds = mod._player_reset_rcon_cmds({"inventory_reset": ["minecraft:cobblestone"]})
    assert any("clear Flint minecraft:cobblestone" in c for c in cmds)
