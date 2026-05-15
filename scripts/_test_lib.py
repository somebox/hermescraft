"""Shared helpers for the legacy scripts/test-*.py functional tests.

Lets every test:
  - Resolve its bot URL from the central config/hermescraft.yaml (with
    HERMESCRAFT_BOT_URL env override) instead of hardcoding a port that
    drifts from the canonical value.
  - Reuse the same rcon / rcon_batch / http_get / http_post helpers
    instead of reimplementing them per file.

Usage:
    from _test_lib import default_bot_url, rcon, rcon_batch, http_get, http_post

    DEFAULT_BOT_URL = default_bot_url("flint")   # or default_bot_url("tester")

The pytest harness under tests/_lib/ is the longer-term home for these
primitives; this module exists to standardize the legacy scripts without
forcing the full pytest migration. Round 3 will fold these into tests/_lib/.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config" / "hermescraft.yaml"

# Sensible fallbacks if config/hermescraft.yaml is missing or unreadable
# (e.g. someone running a test on a checkout without the new config).
_FALLBACK_ROLES = {
    "flint": "http://localhost:3001",
    "tester": "http://localhost:3004",
}
_FALLBACK_RCON = {
    "ssh_host": "ubuntu-host",
    "docker_container": "minecraft",
    "cli": "rcon-cli",
    "command_timeout_s": 20,
    "batch_timeout_s": 60,
}


def _load_config() -> dict:
    """Read config/hermescraft.yaml. Returns {} on any failure; the
    fallbacks above kick in. We avoid raising so a missing config doesn't
    crash every test."""
    if not CONFIG_PATH.exists():
        return {}
    try:
        import yaml
    except ImportError:
        # pyyaml not installed — degrade silently to fallbacks. The
        # production case is that requirements-dev.txt installs it.
        return {}
    try:
        with open(CONFIG_PATH) as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


# Lazy single-load. The helpers below all consult this.
_CFG: dict | None = None


def _cfg() -> dict:
    global _CFG
    if _CFG is None:
        _CFG = _load_config()
    return _CFG


def default_bot_url(role: str = "flint") -> str:
    """Resolve the bot URL for a logical role.

    Resolution order:
      1. $HERMESCRAFT_BOT_URL env var (force-override; useful for one-off runs)
      2. config/hermescraft.yaml: bot.roles[role]
      3. config/hermescraft.yaml: bot.default_api_url (when role unknown)
      4. Hardcoded fallback (flint=3001, tester=3004)
    """
    env_override = os.environ.get("HERMESCRAFT_BOT_URL")
    if env_override:
        return env_override

    cfg = _cfg()
    bot = cfg.get("bot") or {}
    roles = bot.get("roles") or {}
    if role in roles:
        return str(roles[role])
    if "default_api_url" in bot:
        return str(bot["default_api_url"])
    return _FALLBACK_ROLES.get(role, _FALLBACK_ROLES["flint"])


def _rcon_argv() -> list[str]:
    """Build the `ssh ... docker exec ... rcon-cli` argv from config."""
    rcon_cfg = _cfg().get("rcon") or {}
    ssh_host = rcon_cfg.get("ssh_host", _FALLBACK_RCON["ssh_host"])
    container = rcon_cfg.get("docker_container", _FALLBACK_RCON["docker_container"])
    cli = rcon_cfg.get("cli", _FALLBACK_RCON["cli"])
    return ["ssh", ssh_host, "sudo", "docker", "exec", "-i", container, cli]


def rcon(cmd: str, timeout: float | None = None) -> str:
    """Run a single rcon command. Returns combined stdout, stripped."""
    rcon_cfg = _cfg().get("rcon") or {}
    t = timeout if timeout is not None else rcon_cfg.get("command_timeout_s", _FALLBACK_RCON["command_timeout_s"])
    result = subprocess.run(
        _rcon_argv(),
        input=cmd + "\n",
        capture_output=True,
        text=True,
        timeout=t,
    )
    return result.stdout.strip()


def rcon_batch(cmds: list[str], timeout: float | None = None) -> str:
    """Run many rcon commands via a single ssh+rcon-cli invocation.
    Drastically faster than per-command. Returns combined stdout."""
    if not cmds:
        return ""
    rcon_cfg = _cfg().get("rcon") or {}
    t = timeout if timeout is not None else rcon_cfg.get("batch_timeout_s", _FALLBACK_RCON["batch_timeout_s"])
    result = subprocess.run(
        _rcon_argv(),
        input="\n".join(cmds) + "\n",
        capture_output=True,
        text=True,
        timeout=t,
    )
    return result.stdout


def http_get(url: str, timeout: float = 10.0) -> dict:
    """GET a JSON endpoint. Returns parsed JSON."""
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(url: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    """POST JSON to an endpoint. Returns parsed JSON; on HTTPError, returns
    the response body (the bot's HTTP API emits JSON envelopes even on 4xx)."""
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error": {"message": str(e), "code": "HTTP_ERROR"}}
