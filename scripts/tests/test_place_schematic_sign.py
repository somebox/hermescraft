"""Unit tests for sign text helpers in place-schematic-rcon.py."""

from __future__ import annotations

import sys
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_place = SourceFileLoader(
    "place_schematic_rcon",
    str(REPO / "scripts" / "place-schematic-rcon.py"),
).load_module()


class PlaceSchematicSignTest(unittest.TestCase):
    def test_parse_first_front_message_from_capture_string(self) -> None:
        raw = "['\"Base\"', '\"\"', '\"\"', '\"\"']"
        self.assertEqual(_place.parse_first_front_message(raw), "Base")

    def test_parse_first_front_message_skips_empty(self) -> None:
        raw = "['\"\"', '\"Line2\"', '\"\"', '\"\"']"
        self.assertEqual(_place.parse_first_front_message(raw), "Line2")

    def test_sign_front_snbt_includes_text_component(self) -> None:
        snbt = _place.sign_front_snbt(["Base"])
        self.assertIn('{"text":"Base"}', snbt)
        self.assertIn("front_text", snbt)

    def test_sign_text_modify_command_format(self) -> None:
        cmds = _place.sign_text_modify_commands("minecraft:overworld", 1, 2, 3, "Base")
        self.assertEqual(len(cmds), 1)
        self.assertIn("data modify block 1 2 3 front_text.messages", cmds[0])
        self.assertIn('"Base"', cmds[0])

    def test_setblock_command_is_block_only(self) -> None:
        cell = {
            "block": "oak_sign",
            "block_state": "oak_sign[rotation=12,waterlogged=false]",
        }
        cmd = _place.setblock_command("minecraft:overworld", 1, 2, 3, cell)
        self.assertNotIn("front_text", cmd)
        self.assertIn("oak_sign[rotation=12", cmd)


if __name__ == "__main__":
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    unittest.main()
