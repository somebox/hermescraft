"""Loader for config/hermescraft.yaml.

The YAML at the repo root holds cross-cutting settings (MC server, rcon
access, bot defaults, models, logging). Env vars are the final override
channel — anything in the environment that the bot server's
bot/lib/config/index.js reads still wins over this file.

Resolution order for the $overrides block:
    1. $HERMESCRAFT_PROFILE if set
    2. socket.gethostname() (the OS hostname)
"""

from __future__ import annotations

import os
import socket
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / "config" / "hermescraft.yaml"


# Defaults used when PyYAML isn't installed (e.g. bot worker Python envs
# that ship a minimal stdlib). Keeps mc advise / capture_perception_bundle
# working even with no yaml. Cross-check against config/hermescraft.yaml —
# the keys below are the ones touched by tests/_lib/perception_advise.py
# and tests/_lib/bot.py. If new code paths add a config dependency, either
# extend this defaults dict OR have the caller env-var-override first.
_DEFAULTS_WITHOUT_YAML: dict[str, Any] = {
    "mc": {
        "host": "localhost",
        "port": 25565,
        "auth": "offline",
        "world": "landfolk-test",
        "connect_timeout_ms": 55000,
    },
    "bot": {
        # MC_API_URL env var always overrides this in resolve_api_url().
        "default_api_url": "http://localhost:3001",
        "health_poll_timeout_s": 10,
    },
}


def _deep_merge(base: dict, overlay: dict) -> dict:
    """Recursive merge — overlay values win, nested dicts merged."""
    out = dict(base)
    for k, v in overlay.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path: Path | None = None, profile: str | None = None) -> dict[str, Any]:
    """Read config/hermescraft.yaml and apply $overrides for the active profile.

    Args:
        path: Override the default config path. Used by tests.
        profile: Override the resolved profile. Default is $HERMESCRAFT_PROFILE,
                 falling back to the OS hostname.

    Returns:
        Fully resolved config dict with $overrides applied and the
        $overrides key stripped from the result.
    """
    try:
        import yaml  # lazy: bot worker Python envs may not have PyYAML.
    except ImportError:
        # Bot workers (mc advise et al.) don't always carry PyYAML. Fall back
        # to minimal defaults so the advise/digest path works with just
        # MC_API_URL env var. Observed g-2026-05-28-5: Flint hit
        # "advise is broken (missing yaml module)" while trying to dig out
        # mason mid-rescue — a real loss-of-tool moment. Returning defaults
        # is correct because every config key we use here also has an
        # env-var override layer above.
        import warnings
        warnings.warn(
            "PyYAML not installed — using built-in config defaults. "
            "Install pyyaml for full config/hermescraft.yaml support.",
            RuntimeWarning,
            stacklevel=2,
        )
        return {k: dict(v) if isinstance(v, dict) else v for k, v in _DEFAULTS_WITHOUT_YAML.items()}

    config_path = path or CONFIG_PATH
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config not found at {config_path}. "
            "This file is the source of truth for cross-cutting test settings."
        )

    with open(config_path) as f:
        raw = yaml.safe_load(f) or {}

    overrides = raw.pop("$overrides", None) or {}

    resolved_profile = profile or os.environ.get("HERMESCRAFT_PROFILE") or socket.gethostname()
    if resolved_profile in overrides:
        raw = _deep_merge(raw, overrides[resolved_profile])

    return raw
