import pytest

from mapcatalog.lifecycle import delete_and_create_world
from mapcatalog.server_config import ServerConfig


class RecordingRcon:
    def __init__(self, delete_response: str = ""):
        self.commands: list[str] = []
        self._delete_response = delete_response

    def run(self, cmd: str) -> str:
        self.commands.append(cmd)
        if cmd.startswith("mv delete "):
            return self._delete_response
        return ""

    def run_batch(self, cmds: list[str]) -> str:
        self.commands.extend(cmds)
        return ""


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
    )


@pytest.mark.unit
def test_mv_delete_confirm_before_create():
    rcon = RecordingRcon("Please run /mv confirm deadbeef to continue")
    delete_and_create_world(rcon, _cfg(), "424242")
    assert rcon.commands[0] == "mv unload proc-lab"
    assert rcon.commands[1] == "mv delete proc-lab"
    assert "mv confirm deadbeef" in rcon.commands
    assert rcon.commands[-2] == "mv create proc-lab NORMAL -s 424242"
    assert rcon.commands[-1] == "mv load proc-lab"


@pytest.mark.unit
def test_mv_delete_without_otp_still_loads():
    rcon = RecordingRcon("World deleted.")
    delete_and_create_world(rcon, _cfg(), "1")
    assert "mv load proc-lab" in rcon.commands
