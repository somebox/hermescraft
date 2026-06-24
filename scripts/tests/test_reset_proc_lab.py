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


# ── OTP parsing — Phase 10 run-7 launch bug ────────────────────────────


class ParseDeleteOTPTest(unittest.TestCase):
    """Multiverse `mv delete <world>` returns an OTP that must be sent
    back via `/mv confirm <N>` within 30s. The run-7 launch on 2026-06-03
    hit this — the original script fired `mv confirm` with no number,
    got `Invalid OTP number '0'`, and reported false success because
    `mv list` post-failed-delete looks identical to "world untouched"."""

    def test_basic_otp(self):
        stdout = "Are you sure you want to delete world 'proc-lab'?\nRun /mv confirm 953 to continue. This will expire in 30 seconds."
        self.assertEqual(rp.parse_delete_otp(stdout), 953)

    def test_otp_with_color_codes(self):
        # Multiverse output often has color codes intermixed.
        stdout = "[34mAre you sure you want to delete world 'proc-lab'?\n[0mRun [32m/mv confirm 171 [37mto continue."
        self.assertEqual(rp.parse_delete_otp(stdout), 171)

    def test_no_otp_returns_none(self):
        # World doesn't exist, or some other failure mode.
        stdout = "Could not find world 'proc-lab'"
        self.assertIsNone(rp.parse_delete_otp(stdout))

    def test_empty_returns_none(self):
        self.assertIsNone(rp.parse_delete_otp(""))
        self.assertIsNone(rp.parse_delete_otp(None))


# ── Player list parsing — pre-flight safety ────────────────────────────


class ParseOnlinePlayersTest(unittest.TestCase):
    def test_empty_server(self):
        stdout = "There are 0 of a max of 10 players online:"
        self.assertEqual(rp.parse_online_players(stdout), [])

    def test_single_player(self):
        stdout = "There are 1 of a max of 10 players online: re44"
        self.assertEqual(rp.parse_online_players(stdout), ["re44"])

    def test_multiple_players(self):
        stdout = "There are 3 of a max of 10 players online: re44, Steward, Mason"
        self.assertEqual(rp.parse_online_players(stdout), ["re44", "Steward", "Mason"])

    def test_missing_list_line(self):
        # If the rcon transport didn't surface the right line, return [].
        stdout = "some unrelated output"
        self.assertEqual(rp.parse_online_players(stdout), [])

    def test_none_input(self):
        self.assertEqual(rp.parse_online_players(None), [])

    def test_rcon_prompt_artifact_filtered(self):
        # Live run-7 attempt 2026-06-03 observed `> ` prompt appearing
        # after the player-list line; the parser previously captured it
        # as a player name and tried to mvtp `>`.
        stdout = "There are 1 of a max of 10 players online: re44\n>"
        self.assertEqual(rp.parse_online_players(stdout), ["re44"])

    def test_only_prompt_no_players(self):
        stdout = "There are 0 of a max of 10 players online:\n>"
        self.assertEqual(rp.parse_online_players(stdout), [])


# ── Staged command builders ────────────────────────────────────────────


class StagedBuildersTest(unittest.TestCase):
    """The live path stages commands across multiple rcon batches so the
    OTP captured from `mv delete` can be sent within the 30s window
    (without racing cross-session ssh round-trips). Pin the shape."""

    def test_evac_commands_one_per_bot(self):
        cmds = rp.build_evac_commands(hub="hub", bots=["A", "B", "C"])
        self.assertEqual(cmds, ["mvtp A hub", "mvtp B hub", "mvtp C hub"])

    def test_evac_empty_bots(self):
        self.assertEqual(rp.build_evac_commands(hub="hub", bots=[]), [])

    def test_evac_targets_observer_first(self):
        order = rp.build_evac_targets(
            bots=["Mox", "Pip"],
            online_players=["re44", "Mox"],
            observer="re44",
        )
        self.assertEqual(order, ["re44", "Mox", "Pip"])

    def test_evac_targets_strict_skips_humans(self):
        order = rp.build_evac_targets(
            bots=["Mox"],
            online_players=["re44"],
            observer="re44",
            strict=True,
        )
        self.assertEqual(order, ["Mox"])

    def test_evac_targets_never_includes_tester(self):
        order = rp.build_evac_targets(
            bots=["Flint", "Tester"],
            online_players=["Tester", "re44"],
            observer="re44",
        )
        self.assertEqual(order, ["re44", "Flint"])

    def test_delete_unloads_first(self):
        cmds = rp.build_delete_commands("proc-lab")
        self.assertEqual(cmds, ["mv unload proc-lab", "mv delete proc-lab"])

    def test_confirm_includes_otp(self):
        self.assertEqual(rp.build_confirm_command(953), "mv confirm 953")

    def test_create_includes_seed_and_verify(self):
        cmds = rp.build_create_commands(world="proc-lab", seed="1001")
        self.assertEqual(cmds, ["mv create proc-lab NORMAL -s 1001", "mv list"])


if __name__ == "__main__":
    unittest.main()
