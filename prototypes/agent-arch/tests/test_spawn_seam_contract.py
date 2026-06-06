"""Contract tests for the spawn-with-bot seam (Session 4½).

The seam is a test-only stand-in for Section F of impact.md. It encodes
the contract that Section F will need to honour when it lands as a
real Hermes spawn hook: given a card carrying ``metadata.bot``, the
worker that runs the card sees ``MC_API_URL`` + ``MC_USERNAME``
derived from ``data/bots/<bot>.yaml`` — not from the profile's static
``.env``.

These tests are written against the *contract*, not the script. When
Section F lands, swapping the invocation should leave these
assertions passing. Nothing downstream of the env vars couples to
``spawn-with-bot.sh``.

Three classes of assertion:
  1. Lookup correctness — known bot yields the right url + username.
  2. Failure modes — unknown / underspecified inputs exit non-zero
     with informative stderr (loud rather than wrong-body).
  3. Precedence — the seam overrides any ``MC_API_URL`` /
     ``MC_USERNAME`` already in the parent env, matching
     ``bot/cli/api-url.mjs``'s kanban-worker precedence rule.

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Optional

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SEAM_SCRIPT = REPO_ROOT / "scripts" / "colony-validation" / "spawn-with-bot.sh"

# Victim that prints the MC_* env it actually sees as JSON on the last
# stdout line, so the test can parse it deterministically even if other
# noise lands on earlier lines.
_VICTIM = (
    "import os, json; "
    "print(json.dumps({k: os.environ.get(k, '') "
    "for k in ('MC_API_URL', 'MC_USERNAME')}))"
)


@pytest.fixture
def registry(tmp_path: Path) -> Path:
    """A tmpdir bot registry with pip + zee, isolated from the repo."""
    bots = tmp_path / "bots"
    bots.mkdir()
    (bots / "pip.yaml").write_text(textwrap.dedent("""\
        api_port: 3005
        username: Pip
    """))
    (bots / "zee.yaml").write_text(textwrap.dedent("""\
        api_port: 3006
        username: Zee
    """))
    return bots


def _run_seam(
    registry_dir: Path,
    *args: str,
    parent_env: Optional[dict] = None,
    with_victim: bool = True,
) -> tuple[int, dict, str]:
    """Invoke the seam under a controlled env.

    Uses ``env -i`` semantics by building env from scratch (only PATH +
    BOT_REGISTRY_DIR + any caller-supplied overrides), to defend against
    the contract test accidentally passing because of ambient state.

    Returns (returncode, captured_child_env, stderr). captured_child_env
    is the JSON the victim printed, or empty if the seam exited before
    exec.
    """
    env = {
        "PATH": os.environ.get("PATH", ""),
        "BOT_REGISTRY_DIR": str(registry_dir),
    }
    if parent_env:
        env.update(parent_env)

    cmd: list[str] = ["bash", str(SEAM_SCRIPT), *args]
    if with_victim:
        cmd += ["--", sys.executable, "-c", _VICTIM]

    proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
    captured: dict = {}
    if proc.returncode == 0 and with_victim and proc.stdout.strip():
        # Victim is last line; earlier lines (if any) ignored.
        last = proc.stdout.strip().splitlines()[-1]
        try:
            captured = json.loads(last)
        except json.JSONDecodeError:
            captured = {}
    return proc.returncode, captured, proc.stderr


# ---------------------------------------------------------------------
# Contract 1: lookup correctness
# ---------------------------------------------------------------------

class TestLookupCorrectness:
    def test_pip_resolves_to_3005(self, registry: Path) -> None:
        rc, env, stderr = _run_seam(registry, "--bot", "pip")
        assert rc == 0, stderr
        assert env["MC_API_URL"] == "http://127.0.0.1:3005"
        assert env["MC_USERNAME"] == "Pip"

    def test_zee_resolves_to_3006(self, registry: Path) -> None:
        rc, env, stderr = _run_seam(registry, "--bot", "zee")
        assert rc == 0, stderr
        assert env["MC_API_URL"] == "http://127.0.0.1:3006"
        assert env["MC_USERNAME"] == "Zee"

    def test_two_bots_yield_distinct_urls(self, registry: Path) -> None:
        # Belt-and-braces: confirms the seam isn't returning a cached
        # or hardcoded value.
        _, env_pip, _ = _run_seam(registry, "--bot", "pip")
        _, env_zee, _ = _run_seam(registry, "--bot", "zee")
        assert env_pip["MC_API_URL"] != env_zee["MC_API_URL"]
        assert env_pip["MC_USERNAME"] != env_zee["MC_USERNAME"]


# ---------------------------------------------------------------------
# Contract 2: failure modes (loud, not wrong-body)
# ---------------------------------------------------------------------

class TestFailureModes:
    def test_unknown_bot_exits_nonzero_and_names_file(self, registry: Path) -> None:
        rc, _, stderr = _run_seam(registry, "--bot", "ghost")
        assert rc != 0
        assert "ghost.yaml" in stderr

    def test_no_bot_resolvable_exits_nonzero(self, registry: Path) -> None:
        rc, _, stderr = _run_seam(registry, with_victim=False)
        assert rc != 0
        assert "no bot resolved" in stderr.lower() or "bot" in stderr.lower()

    def test_yaml_missing_username_exits_nonzero(self, tmp_path: Path) -> None:
        bots = tmp_path / "bots"
        bots.mkdir()
        (bots / "halfbot.yaml").write_text("api_port: 3007\n")
        rc, _, stderr = _run_seam(bots, "--bot", "halfbot")
        assert rc != 0
        assert "username" in stderr

    def test_yaml_missing_port_exits_nonzero(self, tmp_path: Path) -> None:
        bots = tmp_path / "bots"
        bots.mkdir()
        (bots / "nameonly.yaml").write_text("username: Pip\n")
        rc, _, stderr = _run_seam(bots, "--bot", "nameonly")
        assert rc != 0
        assert "api_port" in stderr

    def test_yaml_non_integer_port_exits_nonzero(self, tmp_path: Path) -> None:
        bots = tmp_path / "bots"
        bots.mkdir()
        (bots / "bad.yaml").write_text("api_port: not-a-port\nusername: Bad\n")
        rc, _, stderr = _run_seam(bots, "--bot", "bad")
        assert rc != 0
        assert "api_port" in stderr

    def test_unknown_cli_arg_exits_nonzero(self, registry: Path) -> None:
        rc, _, stderr = _run_seam(registry, "--what", "ever", with_victim=False)
        assert rc != 0
        assert "unknown arg" in stderr.lower() or "--what" in stderr


# ---------------------------------------------------------------------
# Contract 3: precedence (seam overrides parent env)
# ---------------------------------------------------------------------
# Matches bot/cli/api-url.mjs's kanban-worker precedence rule: when the
# spawn binds a card to a body, the bound value MUST win over whatever
# the parent had set. Otherwise a leaked steward-gateway URL could
# misroute the worker.

class TestPrecedence:
    def test_seam_overrides_parent_mc_api_url(self, registry: Path) -> None:
        rc, env, stderr = _run_seam(
            registry,
            "--bot", "pip",
            parent_env={"MC_API_URL": "http://stale.example:9999"},
        )
        assert rc == 0, stderr
        assert env["MC_API_URL"] == "http://127.0.0.1:3005"

    def test_seam_overrides_parent_mc_username(self, registry: Path) -> None:
        rc, env, stderr = _run_seam(
            registry,
            "--bot", "pip",
            parent_env={"MC_USERNAME": "Stale"},
        )
        assert rc == 0, stderr
        assert env["MC_USERNAME"] == "Pip"

    def test_precedence_holds_across_bot_switches(self, registry: Path) -> None:
        # The same parent_env, with two different --bot values, must
        # produce two different child envs. Defends against an
        # implementation that silently fell back to parent on second
        # invocation.
        _, env_pip, _ = _run_seam(
            registry, "--bot", "pip",
            parent_env={"MC_API_URL": "http://stale.example:9999"},
        )
        _, env_zee, _ = _run_seam(
            registry, "--bot", "zee",
            parent_env={"MC_API_URL": "http://stale.example:9999"},
        )
        assert env_pip["MC_API_URL"] == "http://127.0.0.1:3005"
        assert env_zee["MC_API_URL"] == "http://127.0.0.1:3006"
