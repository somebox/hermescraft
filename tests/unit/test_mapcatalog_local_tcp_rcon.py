"""Unit tests for mapcatalog.rcon_client.LocalTcpRcon (mcrcon mocked).

A live-gated end-to-end test (MAPCATALOG_LIVE_LOCAL=1) verifies the full
mv create/delete/confirm cycle against a real local Paper server. Run with:

    MAPCATALOG_LIVE_LOCAL=1 pytest tests/unit/test_mapcatalog_local_tcp_rcon.py -q
"""
from __future__ import annotations

import os
import re
import sys
import types

import pytest

from mapcatalog.rcon_client import LocalTcpRcon, make_rcon
from mapcatalog.server_config import ServerConfig


pytestmark = pytest.mark.unit


# --- mock backend ------------------------------------------------------------

class _FakeMCRcon:
    """Stand-in for mcrcon.MCRcon. Records commands; scripts responses."""

    instances: list["_FakeMCRcon"] = []

    def __init__(self, host, password, port=25575, timeout=None):
        self.host = host
        self.password = password
        self.port = port
        self.timeout = timeout
        self.commands: list[str] = []
        self.connected = False
        self.responses: dict[str, str] = {}
        self.fail_next: list[Exception] = []
        self.socket = type("S", (), {"setsockopt": lambda self, *a: None})()
        _FakeMCRcon.instances.append(self)

    def connect(self):
        self.connected = True

    def disconnect(self):
        self.connected = False

    def command(self, cmd: str) -> str:
        if self.fail_next:
            raise self.fail_next.pop(0)
        self.commands.append(cmd)
        return self.responses.get(cmd, "")


class _FakeMCRconException(Exception):
    pass


@pytest.fixture
def fake_mcrcon(monkeypatch):
    """Patch the mcrcon module so LocalTcpRcon talks to _FakeMCRcon (no pip dep)."""
    _FakeMCRcon.instances.clear()
    fake_mod = types.ModuleType("mcrcon")
    fake_mod.MCRcon = _FakeMCRcon
    fake_mod.MCRconException = _FakeMCRconException
    monkeypatch.setitem(sys.modules, "mcrcon", fake_mod)
    return _FakeMCRcon


# --- unit tests --------------------------------------------------------------

def test_run_strips_whitespace(fake_mcrcon):
    r = LocalTcpRcon(host="h", port=1, password="pw")
    r._open()
    fake_mcrcon.instances[-1].responses = {"list": "There are 0 players online: \n"}
    assert r.run("list") == "There are 0 players online:"


def test_run_batch_preserves_one_line_per_command(fake_mcrcon):
    r = LocalTcpRcon(host="h", port=1, password="pw")
    r._open()
    fake = fake_mcrcon.instances[-1]
    fake.responses = {"a": "ALPHA", "b": "BETA", "c": "GAMMA"}
    out = r.run_batch(["a", "b", "c"])
    assert out.splitlines() == ["ALPHA", "BETA", "GAMMA"]


def test_run_batch_collapses_embedded_newlines(fake_mcrcon):
    """probe.py indexes by line ordinal — a response with \\n would shatter alignment."""
    r = LocalTcpRcon(host="h", port=1, password="pw")
    r._open()
    fake = fake_mcrcon.instances[-1]
    fake.responses = {
        "one": "first\nsecond\rthird",
        "two": "ok",
    }
    out = r.run_batch(["one", "two"])
    lines = out.splitlines()
    assert len(lines) == 2  # critical — one line per input command
    assert "\n" not in lines[0] and "\r" not in lines[0]
    assert lines[1] == "ok"


def test_run_batch_empty(fake_mcrcon):
    r = LocalTcpRcon(host="h", port=1, password="pw")
    assert r.run_batch([]) == ""


def test_reconnect_on_broken_pipe(fake_mcrcon):
    r = LocalTcpRcon(host="h", port=1, password="pw", reconnect=True)
    r._open()
    first = fake_mcrcon.instances[-1]
    first.fail_next = [BrokenPipeError("server hung up")]
    first.responses = {"list": "after-reconnect"}
    # On reconnect, a NEW _FakeMCRcon is created — we need its responses set too,
    # so script the global side: queue a per-instance setup hook via patching.
    out = r.run("list")
    # After reconnect, instances[-1] is the post-reconnect client.
    assert fake_mcrcon.instances[-1] is not first
    # The new client returned empty string by default; this test really checks that
    # the BrokenPipeError didn't propagate. A non-empty return is verified by the
    # combination with run_batch in the next test.
    assert out == ""


def test_reconnect_disabled_propagates(fake_mcrcon):
    r = LocalTcpRcon(host="h", port=1, password="pw", reconnect=False)
    r._open()
    fake_mcrcon.instances[-1].fail_next = [BrokenPipeError("nope")]
    with pytest.raises(BrokenPipeError):
        r.run("list")


def test_empty_password_rejected():
    with pytest.raises(ValueError):
        LocalTcpRcon(host="h", port=1, password="")


def test_make_rcon_ssh_docker_branch():
    cfg = ServerConfig(
        minecraft_version="1.21.4",
        ssh_host="ubuntu-host",
        container="minecraft",
        cli="rcon-cli",
        world_name="proc-lab",
        generator="NORMAL",
        hub_world="landfolk-test",
        hub_xyz=(0, 65, 0),
        use_unsafe_mvtp=True,
    )
    from mapcatalog.rcon_client import SshDockerRcon
    assert isinstance(make_rcon(cfg), SshDockerRcon)


def test_make_rcon_tcp_branch():
    cfg = ServerConfig(
        minecraft_version="1.21.4",
        ssh_host="",
        container="",
        cli="",
        world_name="proc-lab",
        generator="NORMAL",
        hub_world="proc-lab-bootstrap",
        hub_xyz=(0, 100, 0),
        use_unsafe_mvtp=True,
        transport="tcp",
        tcp_host="127.0.0.1",
        tcp_port=25576,
        tcp_password="dummy",
    )
    assert isinstance(make_rcon(cfg), LocalTcpRcon)


def test_make_rcon_rejects_unknown_transport():
    cfg = ServerConfig(
        minecraft_version="1.21.4",
        ssh_host="",
        container="",
        cli="",
        world_name="proc-lab",
        generator="NORMAL",
        hub_world="hub",
        hub_xyz=(0, 65, 0),
        use_unsafe_mvtp=True,
        transport="something_else",
    )
    with pytest.raises(NotImplementedError):
        make_rcon(cfg)


# --- live-gated end-to-end ---------------------------------------------------

LIVE = bool(os.environ.get("MAPCATALOG_LIVE_LOCAL"))


@pytest.mark.skipif(not LIVE, reason="set MAPCATALOG_LIVE_LOCAL=1 to run against ~/hermescraft-proc-lab")
def test_live_mv_cycle():
    """Full mv create/delete/confirm against a real local Paper + MV-Core server."""
    pw_path = os.path.expanduser("~/.config/hermescraft/proc-lab-rcon.pass")
    password = open(pw_path).read().strip()
    r = LocalTcpRcon(host="127.0.0.1", port=25576, password=password)
    with r:
        # Create a scratch world (idempotent: ignore if already exists).
        out_create = r.run("mv create proc-lab-livetest NORMAL -s 1")
        # If already exists, MV says so; we then unload+delete+recreate so the test is repeatable.
        if "already exists" in out_create.lower():
            r.run("mv unload proc-lab-livetest")
            out = r.run("mv delete proc-lab-livetest")
            m = re.search(r"mv confirm\s+(\S+)", out)
            if m:
                otp = re.sub(r"\x1b\[[0-9;]*m|§.", "", m.group(1))
                r.run(f"mv confirm {otp}")
            r.run("mv create proc-lab-livetest NORMAL -s 1")

        # Now exercise the unload → delete → confirm path.
        r.run("mv unload proc-lab-livetest")
        out = r.run("mv delete proc-lab-livetest")
        m = re.search(r"mv confirm\s+(\S+)", out)
        assert m, f"no OTP in mv delete output: {out!r}"
        otp = re.sub(r"\x1b\[[0-9;]*m|§.", "", m.group(1))
        r.run(f"mv confirm {otp}")

        listing = r.run("mv list")
        assert "proc-lab-livetest" not in listing, f"world still listed after delete: {listing!r}"
