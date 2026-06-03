"""Phase 10 PR-U unit tests — `build_reset_commands` pure-function.

The rcon execution (`run_rcon_batch` shell-out) is operator-tested only.
This bench locks in the command shape + ordering so future server config
changes don't accidentally drop the evac step or reorder delete-before-create.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _load_reset():
    loader = SourceFileLoader(
        "reset_proc_lab",
        str(REPO / "scripts" / "reset-proc-lab.py"),
    )
    spec = importlib.util.spec_from_loader("reset_proc_lab", loader)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["reset_proc_lab"] = mod
    loader.exec_module(mod)
    return mod


rp = _load_reset()


class BuildResetCommandsTest(unittest.TestCase):
    def test_default_shape(self):
        cmds = rp.build_reset_commands(
            world="proc-lab",
            seed="1001",
            hub="landfolk-test",
            bots=["Flint", "Mason"],
        )
        # Order: evac all bots, then unload, then delete, then create, then list.
        self.assertEqual(cmds, [
            "mvtp Flint landfolk-test",
            "mvtp Mason landfolk-test",
            "mv unload proc-lab",
            "mv delete proc-lab",
            "mv create proc-lab NORMAL -s 1001",
            "mv list",
        ])

    def test_evac_before_delete(self):
        # Critical invariant — never delete a world with players still in it.
        cmds = rp.build_reset_commands(
            world="proc-lab",
            seed="1001",
            hub="landfolk-test",
            bots=["A", "B", "C", "D"],
        )
        delete_idx = next(i for i, c in enumerate(cmds) if "mv delete" in c)
        for i, c in enumerate(cmds):
            if c.startswith("mvtp "):
                self.assertLess(i, delete_idx,
                                msg=f"evac command {c!r} at idx {i} must precede mv delete at idx {delete_idx}")

    def test_unload_before_delete(self):
        # Multiverse flushes chunks on `mv unload`; deleting a loaded world
        # risks orphaned region files. Lock the order.
        cmds = rp.build_reset_commands(
            world="proc-lab", seed="1001", hub="hub", bots=["A"],
        )
        unload_idx = next(i for i, c in enumerate(cmds) if "mv unload" in c)
        delete_idx = next(i for i, c in enumerate(cmds) if "mv delete" in c)
        self.assertLess(unload_idx, delete_idx)

    def test_create_after_delete(self):
        cmds = rp.build_reset_commands(
            world="proc-lab", seed="1001", hub="hub", bots=["A"],
        )
        delete_idx = next(i for i, c in enumerate(cmds) if "mv delete" in c)
        create_idx = next(i for i, c in enumerate(cmds) if c.startswith("mv create "))
        self.assertLess(delete_idx, create_idx)

    def test_seed_embedded(self):
        cmds = rp.build_reset_commands(
            world="proc-lab", seed="4242", hub="hub", bots=[],
        )
        create_cmd = next(c for c in cmds if c.startswith("mv create "))
        self.assertIn("-s 4242", create_cmd)

    def test_custom_generator(self):
        cmds = rp.build_reset_commands(
            world="proc-lab", seed="1001", hub="hub", bots=[],
            generator="FLAT",
        )
        self.assertIn("mv create proc-lab FLAT -s 1001", cmds)

    def test_empty_bots_list(self):
        # When no bots are online (e.g. first reset before fleet ever ran)
        # we skip the evac block but still execute the world reset.
        cmds = rp.build_reset_commands(
            world="proc-lab", seed="1001", hub="hub", bots=[],
        )
        self.assertFalse(any(c.startswith("mvtp ") for c in cmds))
        self.assertEqual(cmds, [
            "mv unload proc-lab",
            "mv delete proc-lab",
            "mv create proc-lab NORMAL -s 1001",
            "mv list",
        ])

    def test_steward_evac_last(self):
        # DEFAULT_BOTS order puts Steward last so her continuous loop
        # doesn't grab the proc-lab tile in the brief window between
        # evac and delete. Document the invariant via a regression test.
        self.assertEqual(rp.DEFAULT_BOTS[-1], "Steward")

    def test_world_name_substitution(self):
        cmds = rp.build_reset_commands(
            world="lab-alt", seed="1001", hub="hub", bots=["A"],
        )
        self.assertIn("mvtp A hub", cmds)
        self.assertIn("mv unload lab-alt", cmds)
        self.assertIn("mv delete lab-alt", cmds)
        self.assertIn("mv create lab-alt NORMAL -s 1001", cmds)


if __name__ == "__main__":
    unittest.main()
