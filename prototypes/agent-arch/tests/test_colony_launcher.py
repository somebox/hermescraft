"""Contract tests for the colony launcher (scripts/colony).

The launcher is a bash script that spawns Mineflayer processes. The
spawn path can't run in a unit test (no MC server, no listening
processes), but the *logic* — registry lookup, env composition,
JSON output shape, dry-run reporting — IS testable. The script
exposes `--dry-run` and `status` modes specifically for this seam.

What we prove with these tests:
  - Status output (text + JSON) reflects every yaml in the registry,
    in alphabetical order, with the right port/username.
  - `start --all --dry-run` enumerates every bot with the env vars
    a real launch would set (MC_USERNAME, API_PORT, VIEWER_PORT,
    log path).
  - `start --bot a,b` selects only the named subset.
  - `stop --bot a --dry-run` names the right user.
  - Unknown subcommand exits non-zero with a helpful message.
  - Missing yaml field surfaces as a registry-error in status, not
    a silent skip.

Plan: reports/agent-arch/2026-06-06-colony-validation-plan.md
(Session 5b prep gap 3).
"""

from __future__ import annotations

import json
import os
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
COLONY = REPO_ROOT / "scripts" / "colony"


@pytest.fixture
def registry(tmp_path: Path) -> Path:
    """Tmp bot registry — three bots so we can prove alphabetical
    ordering and subset selection without colliding with the real
    `data/bots/` files."""
    bots = tmp_path / "bots"
    bots.mkdir()
    (bots / "alpha.yaml").write_text(textwrap.dedent("""\
        api_port: 3101
        username: Alpha
    """))
    (bots / "bravo.yaml").write_text(textwrap.dedent("""\
        api_port: 3102
        username: Bravo
    """))
    (bots / "charlie.yaml").write_text(textwrap.dedent("""\
        api_port: 3103
        username: Charlie
    """))
    return bots


def _run(registry_dir: Path, *args: str, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "BOT_REGISTRY_DIR": str(registry_dir),
        # Force a tmp log dir so status can't see ambient logs.
        "COLONY_LOG_DIR": str(registry_dir.parent / "logs"),
    }
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        ["bash", str(COLONY), *args],
        env=env,
        capture_output=True,
        text=True,
    )


# ── status ─────────────────────────────────────────────────────────

class TestStatus:
    def test_text_status_lists_every_bot_alphabetical(self, registry: Path) -> None:
        proc = _run(registry, "status")
        assert proc.returncode == 0, proc.stderr
        # Header + 3 bot rows.
        lines = [l for l in proc.stdout.splitlines() if l.strip()]
        assert lines[0].startswith("BOT")
        bots_in_order = [l.split()[0] for l in lines[1:]]
        assert bots_in_order == ["alpha", "bravo", "charlie"]

    def test_text_status_includes_port_and_username(self, registry: Path) -> None:
        proc = _run(registry, "status")
        # alpha row should have 3101 and Alpha.
        alpha_row = next(l for l in proc.stdout.splitlines() if l.startswith("alpha"))
        assert "3101" in alpha_row
        assert "Alpha" in alpha_row

    def test_json_status_is_valid_json_and_lists_three(self, registry: Path) -> None:
        proc = _run(registry, "status", "--json")
        assert proc.returncode == 0, proc.stderr
        data = json.loads(proc.stdout)
        assert isinstance(data, list)
        assert len(data) == 3
        names = [d["bot"] for d in data]
        assert names == ["alpha", "bravo", "charlie"]
        # When no bots are running, status should be "down".
        assert all(d["status"] == "down" for d in data)
        # Schema sanity.
        for d in data:
            assert set(d.keys()) == {"bot", "api_port", "username", "status"}

    def test_status_surfaces_registry_error_on_malformed_yaml(self, tmp_path: Path) -> None:
        bots = tmp_path / "bots"
        bots.mkdir()
        (bots / "broken.yaml").write_text("api_port: 3200\n")  # no username
        (bots / "good.yaml").write_text("api_port: 3201\nusername: Good\n")
        proc = _run(bots, "status", "--json")
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        statuses = {d["bot"]: d["status"] for d in data}
        assert statuses["broken"] == "registry-error"
        assert statuses["good"] == "down"


# ── start --dry-run ────────────────────────────────────────────────

class TestStartDryRun:
    def test_all_lists_every_bot_with_env(self, registry: Path) -> None:
        proc = _run(registry, "start", "--all", "--dry-run")
        assert proc.returncode == 0, proc.stderr
        for bot, port, user in [
            ("alpha", "3101", "Alpha"),
            ("bravo", "3102", "Bravo"),
            ("charlie", "3103", "Charlie"),
        ]:
            assert f"would start {bot}" in proc.stdout
            assert f"MC_USERNAME={user}" in proc.stdout
            assert f"API_PORT={port}" in proc.stdout

    def test_viewer_port_is_api_port_plus_offset(self, registry: Path) -> None:
        proc = _run(registry, "start", "--all", "--dry-run")
        # Default offset is 1000; bravo on 3102 → 4102.
        assert "VIEWER_PORT=4102" in proc.stdout

    def test_bot_subset_selects_only_named(self, registry: Path) -> None:
        proc = _run(registry, "start", "--bot", "alpha,charlie", "--dry-run")
        assert proc.returncode == 0
        assert "would start alpha" in proc.stdout
        assert "would start charlie" in proc.stdout
        assert "would start bravo" not in proc.stdout

    def test_default_no_flag_treats_as_all(self, registry: Path) -> None:
        # No --bot and no --all: should still default to the full
        # registry (the docstring at the top of the script says so).
        proc = _run(registry, "start", "--dry-run")
        assert proc.returncode == 0
        for bot in ("alpha", "bravo", "charlie"):
            assert f"would start {bot}" in proc.stdout

    def test_unknown_bot_silently_skipped_with_warn(self, registry: Path) -> None:
        # Only valid bots launch; unknown ones warn but don't crash.
        proc = _run(registry, "start", "--bot", "ghost", "--dry-run")
        assert "would start ghost" not in proc.stdout
        # Either warns on stderr or exits non-zero; both are fine.
        assert "ghost" in (proc.stderr + proc.stdout)

    def test_mc_host_overridable(self, registry: Path) -> None:
        proc = _run(
            registry, "start", "--all", "--dry-run",
            env_extra={"MC_HOST": "minecraft.example.lan"},
        )
        assert "MC_HOST=minecraft.example.lan" in proc.stdout


# ── stop --dry-run ─────────────────────────────────────────────────

class TestStopDryRun:
    def test_stop_names_username_not_bot_id(self, registry: Path) -> None:
        # stop-bots.sh is name-targeted, so we pass the in-game name.
        proc = _run(registry, "stop", "--bot", "alpha", "--dry-run")
        assert proc.returncode == 0
        assert "would stop alpha" in proc.stdout
        assert "user=Alpha" in proc.stdout

    def test_stop_all_lists_every_bot(self, registry: Path) -> None:
        proc = _run(registry, "stop", "--all", "--dry-run")
        for bot, user in [("alpha", "Alpha"), ("bravo", "Bravo"), ("charlie", "Charlie")]:
            assert f"would stop {bot}" in proc.stdout
            assert f"user={user}" in proc.stdout


# ── dispatch errors ────────────────────────────────────────────────

class TestDispatch:
    def test_unknown_subcommand_exits_64(self, registry: Path) -> None:
        proc = _run(registry, "wibble")
        assert proc.returncode == 64
        # Helpful message names the valid set.
        assert "unknown subcommand" in proc.stderr
        assert "start" in proc.stderr

    def test_die_message_does_not_include_exit_code(self, registry: Path) -> None:
        # Regression check: an earlier version printed `${*}` in die,
        # so the exit code (64) leaked into the user-facing message.
        proc = _run(registry, "wibble")
        # The number "64" must NOT appear in the error string.
        assert " 64" not in proc.stderr.rstrip()
        assert proc.stderr.rstrip()[-2:] != "64"

    def test_logs_missing_file_errors(self, registry: Path) -> None:
        proc = _run(registry, "logs", "alpha")
        # No log file written yet.
        assert proc.returncode != 0
        assert "no log file" in proc.stderr.lower() or "log" in proc.stderr.lower()
